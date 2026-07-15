from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone
from pathlib import Path

import click
import yaml
from rich.console import Console
from rich.table import Table

from harvester.config import DATA_DIR, DEFAULT_HARVEST_CONCURRENCY, DEFAULT_TEST_CONCURRENCY, DEFAULT_TIMEOUT, SOURCES_FILE
from harvester.dedup import deduplicate
from harvester.models import HarvestState, ParsedStream, SourceConfig, SourceType, StreamTestResult, TestState
from harvester.report import generate_report, print_summary, save_report
from harvester.state import load_harvest_state, load_streams, load_test_state, save_harvest_state, save_results, save_streams, save_test_state
from harvester.tester import test_streams

console = Console()


def _load_sources(path: Path, filter_type: str | None = None, filter_name: str | None = None) -> list[SourceConfig]:
    with open(path, encoding="utf-8") as f:
        data = yaml.safe_load(f)
    sources = [SourceConfig(**s) for s in data.get("sources", [])]
    if filter_type:
        sources = [s for s in sources if s.type.value == filter_type]
    if filter_name:
        sources = [s for s in sources if filter_name.lower() in s.source_id().lower()]
    return sources


def _get_scraper(config: SourceConfig):
    from harvester.sources.direct import DirectSource
    from harvester.sources.famelack import FamelackSource
    from harvester.sources.github import GitHubSource
    from harvester.sources.paste import PasteSource
    from harvester.sources.telegram import TelegramSource
    from harvester.sources.website import WebsiteSource

    return {
        SourceType.GITHUB: GitHubSource,
        SourceType.WEBSITE: WebsiteSource,
        SourceType.TELEGRAM: TelegramSource,
        SourceType.PASTE: PasteSource,
        SourceType.DIRECT: DirectSource,
        SourceType.FAMELACK: FamelackSource,
    }[config.type](config)


async def _harvest(sources: list[SourceConfig], concurrency: int, resume: bool) -> list[ParsedStream]:
    import aiohttp

    state = load_harvest_state() if resume else HarvestState()
    state.run_id = state.run_id or datetime.now(timezone.utc).isoformat()
    all_streams: list[ParsedStream] = []
    sem = asyncio.Semaphore(concurrency)

    completed = set(state.sources_completed)
    pending = [s for s in sources if s.source_id() not in completed]

    console.print(f"[bold]Harvesting from {len(pending)} sources[/] ({len(completed)} already done)")

    async with aiohttp.ClientSession() as session:
        async def fetch_source(src: SourceConfig) -> tuple[str, list[ParsedStream]]:
            async with sem:
                sid = src.source_id()
                try:
                    scraper = _get_scraper(src)
                    streams = await scraper.fetch(session)
                    console.print(f"  [green]OK[/] {sid}: {len(streams)} streams")
                    return sid, streams
                except Exception as e:
                    console.print(f"  [red]FAIL[/] {sid}: {e}")
                    return sid, []

        tasks = [fetch_source(s) for s in pending]
        results = await asyncio.gather(*tasks)

    for sid, streams in results:
        if streams:
            all_streams.extend(streams)
            state.sources_completed.append(sid)
        else:
            state.sources_failed.append(sid)

    deduped = deduplicate(all_streams)
    state.streams_collected = len(deduped)
    save_harvest_state(state)
    save_streams(deduped)

    console.print(f"\n[bold green]Harvested {len(all_streams)} streams, {len(deduped)} unique after dedup[/]")
    return deduped


async def _test(streams: list[ParsedStream], timeout: float, concurrency: int, resume: bool) -> list[StreamTestResult]:
    state = load_test_state() if resume else TestState()
    state.run_id = state.run_id or datetime.now(timezone.utc).isoformat()

    tested = state.tested_urls if resume else {}
    console.print(f"[bold]Testing {len(streams)} streams[/] ({len(tested)} already tested, concurrency={concurrency})")

    def on_result(r: StreamTestResult):
        state.tested_urls[r.url] = r.status.value
        if len(state.tested_urls) % 100 == 0:
            save_test_state(state)

    results = await test_streams(streams, timeout=timeout, concurrency=concurrency, tested_urls=tested, on_result=on_result)

    save_test_state(state)
    save_results(results)
    return results


@click.group()
def main():
    """IPTV Stream Harvester — discover, test, and report on live streams."""
    pass


@main.command()
@click.option("--sources-file", type=click.Path(exists=True), default=str(SOURCES_FILE))
@click.option("--filter-type", type=click.Choice(["github", "website", "telegram", "paste", "direct", "famelack"]))
@click.option("--filter-name", type=str, default=None)
@click.option("--concurrency", type=int, default=DEFAULT_HARVEST_CONCURRENCY)
@click.option("--resume/--no-resume", default=True)
def harvest(sources_file, filter_type, filter_name, concurrency, resume):
    """Fetch M3U playlists from all configured sources."""
    sources = _load_sources(Path(sources_file), filter_type, filter_name)
    if not sources:
        console.print("[red]No sources matched filters[/]")
        return
    asyncio.run(_harvest(sources, concurrency, resume))


@main.command("snapshot-sources")
@click.option("--output", type=click.Path(path_type=Path), default=None,
              help="Snapshot directory (default: data/source-snapshots/<UTC timestamp>).")
@click.option("--configured/--no-configured", default=True, help="Include sources.yaml endpoints.")
@click.option("--legacy/--no-legacy", default=True, help="Include ../sources.txt candidate sites.")
@click.option("--concurrency", type=int, default=6)
def snapshot_sources(output, configured, legacy, concurrency):
    """Retain local copies + a hash/status manifest for every source endpoint."""
    from datetime import datetime, timezone
    from harvester.snapshot_sources import snapshot

    if output is None:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        output = DATA_DIR / "source-snapshots" / stamp
    result = asyncio.run(snapshot(output, configured, legacy, concurrency))
    console.print(f"Snapshot: {output}")
    console.print(
        f"Targets: {result['targets']}, downloaded: {result['downloaded']}, "
        f"HTTP 2xx: {result['http_success']}"
    )


@main.command()
@click.option("--input", "input_file", type=str, default="harvested_streams.json")
@click.option("--timeout", type=float, default=DEFAULT_TIMEOUT)
@click.option("--concurrency", type=int, default=DEFAULT_TEST_CONCURRENCY)
@click.option("--resume/--no-resume", default=True)
@click.option("--limit", type=int, default=None, help="Max streams to test")
def test(input_file, timeout, concurrency, resume, limit):
    """Test collected streams with ffprobe."""
    raw = load_streams(input_file)
    if not raw:
        console.print("[red]No streams found. Run 'harvest' first.[/]")
        return
    streams = [ParsedStream(**s) for s in raw]
    if limit:
        streams = streams[:limit]
    results = asyncio.run(_test(streams, timeout, concurrency, resume))
    console.print(f"\n[bold green]Tested {len(results)} streams[/]")


@main.command()
@click.option("--input", "input_file", type=str, default="test_results.json")
@click.option("--working-only", is_flag=True, default=False)
def report(input_file, working_only):
    """Generate report from test results."""
    path = DATA_DIR / input_file
    if not path.exists():
        console.print("[red]No test results found. Run 'test' first.[/]")
        return
    raw = json.loads(path.read_text())
    results = [StreamTestResult(**r) for r in raw]
    if working_only:
        results = [r for r in results if r.status == "working"]

    rep = generate_report(results)
    save_report(rep)
    print_summary(rep)

    table = Table(title="Top Working Streams")
    table.add_column("Channel", style="cyan")
    table.add_column("URL", style="blue", max_width=60)
    table.add_column("Codec", style="green")
    table.add_column("Resolution", style="yellow")
    table.add_column("Time (ms)", style="magenta")

    for s in rep.streams[:50]:
        if s.status == "working":
            table.add_row(
                s.channel_name or "-",
                s.url[:60],
                s.codecs.video or "-",
                s.codecs.resolution or "-",
                str(s.response_time_ms),
            )
    console.print(table)


@main.command()
@click.option("--timeout", type=float, default=DEFAULT_TIMEOUT)
@click.option("--concurrency", type=int, default=DEFAULT_TEST_CONCURRENCY)
@click.option("--dry-run", is_flag=True, default=False, help="Test only, don't remove streams")
def prune(timeout, concurrency, dry_run):
    """Test all streams in the addon catalog and remove dead ones."""
    from harvester.prune import prune as do_prune
    stats = do_prune(timeout=timeout, concurrency=concurrency, dry_run=dry_run)
    console.print(f"\n[bold]Tested: {stats['tested']}, Dead: {stats['dead']}, Removed: {stats['removed']}[/]")


@main.command("inject")
@click.option("--input", "input_file", type=str, default="data/test_results.json")
def inject_cmd(input_file):
    """Inject working streams from test results into catalog channels."""
    from harvester.inject import inject
    stats = inject(input_file)
    console.print(f"Channels updated: {stats['channels_updated']}")
    console.print(f"Streams added: {stats['streams_added']}")


@main.command("famelack-import-curated")
@click.option("--timeout", type=float, default=DEFAULT_TIMEOUT)
@click.option("--concurrency", type=int, default=DEFAULT_TEST_CONCURRENCY)
def famelack_import_curated(timeout, concurrency):
    """Bulk-import the full curated famelack candidate set (deduped, ffprobe-validated, per-genre)."""
    from harvester.famelack_import import import_curated
    stats = import_curated(timeout=timeout, concurrency=concurrency)
    for k, v in stats.items():
        console.print(f"  {k}: {v}")


@main.command("famelack-curate")
def famelack_curate():
    """Report curated NEW-channel candidates from famelack (relevance + quality filtered)."""
    from harvester.famelack_curate import curate
    stats = curate()
    console.print(f"[bold]Curated candidates:[/] {stats['candidates']}")
    console.print(f"By genre: {stats['by_genre']}")
    console.print(f"Rejected: {stats['rejected']}")
    console.print(f"Report written: {stats['report']}")


@main.command("famelack-import")
@click.option("--keyword", required=True, help="Import famelack channels whose name contains this (e.g. 'telemundo').")
@click.option("--genre", required=True, help="Genre to assign the imported channels (e.g. 'Latino').")
@click.option("--logo", "logo_slug", default=None, help="Repo art slug to reuse (e.g. 'telemundo-us'); else iptv-org.")
@click.option("--timeout", type=float, default=DEFAULT_TIMEOUT)
@click.option("--concurrency", type=int, default=DEFAULT_TEST_CONCURRENCY)
def famelack_import(keyword, genre, logo_slug, timeout, concurrency):
    """Import NEW catalog channels from famelack (deduped, ffprobe-validated). Curated/test import."""
    from harvester.famelack_import import import_channels
    stats = import_channels(keyword, genre, logo_slug, timeout=timeout, concurrency=concurrency)
    for k, v in stats.items():
        console.print(f"  {k}: {v}")


@main.command("famelack-enrich")
@click.option("--timeout", type=float, default=DEFAULT_TIMEOUT)
@click.option("--concurrency", type=int, default=DEFAULT_TEST_CONCURRENCY)
def famelack_enrich(timeout, concurrency):
    """Add ffprobe-validated famelack streams to existing catalog channels (no new channels)."""
    from harvester.famelack_enrich import enrich
    stats = enrich(timeout=timeout, concurrency=concurrency)
    for k, v in stats.items():
        console.print(f"  {k}: {v}")


@main.command()
@click.option("--force", is_flag=True, default=False, help="Re-download logos even if a local file exists.")
def logos(force):
    """Grab channel logos from iptv-org for catalog channels missing a local logo file."""
    from harvester.logos import grab_missing
    stats = grab_missing(force=force)
    console.print(f"  present: {stats['present']}, downloaded: {stats['downloaded']}, missing: {stats['missing']}")


@main.command()
@click.option("--only", default=None, help="Comma-separated channel names to (re)generate (default: all famelack).")
def banners(only):
    """Normalize channel art into Nuvio-friendly 2:3 posters: composite each famelack
    channel's logo (iptv-org > curated override > own art, placeholders rejected, else a
    clean text wordmark) onto the originals' neutral background, and self-host every art URL."""
    from harvester.banners import run
    run(set(s.strip() for s in only.split(",")) if only else None)


@main.command("iptvorg-enrich")
@click.option("--apply", is_flag=True, default=False, help="Write the validated new streams (default: dry-run report).")
@click.option("--limit", type=int, default=None, help="Validate only the first N candidates (debug).")
def iptvorg_enrich(apply, limit):
    """Add reliable NEW streams from iptv-org's US playlist to EXISTING catalog channels
    (the source behind zhangboheng's Easy-Web-TV-M3u8). Matches by name, applies the
    curation rules, ffprobe-validates (live + real video), dedups, reorders."""
    from harvester.iptvorg import enrich
    enrich(apply=apply, limit=limit)


@main.command("iptvorg-candidates")
def iptvorg_candidates():
    """Categorize iptv-org US channels we DON'T have yet by the curation rules (report only)."""
    from harvester.iptvorg import candidates
    candidates()


@main.command()
@click.option("--dry-run", is_flag=True, default=False, help="Report only; do not write files.")
def relabel(dry_run):
    """Reformat stream names to the detailed convention (e.g. 'CBSN - Denver (HD)'); no re-probe."""
    from harvester.consolidate import relabel as do_relabel
    stats = do_relabel(dry_run=dry_run)
    for k, v in stats.items():
        console.print(f"  {k}: {v}")


@main.command()
@click.option("--dry-run", is_flag=True, default=False, help="Report only; do not write files.")
def regionalize(dry_run):
    """Order each channel's feeds by local relevance (Denver/CO > National > other); drop dup feeds."""
    from harvester.regional import regionalize as do_regionalize
    stats = do_regionalize(dry_run=dry_run)
    for k, v in stats.items():
        console.print(f"  {k}: {v}")


@main.command()
@click.option("--dry-run", is_flag=True, default=False, help="Report only; do not write files.")
@click.option("--concurrency", type=int, default=DEFAULT_TEST_CONCURRENCY)
@click.option("--no-drop", is_flag=True, default=False,
              help="Fix formats + disambiguate names but NEVER drop a stream (transient/geo/proxy-only "
                   "failures keep their existing label). Use this for format double-checking.")
def consolidate(dry_run, concurrency, no_drop):
    """Re-probe all streams: fix Audio/video labels + add unique provider identifiers (and,
    without --no-drop, drop dead streams)."""
    from harvester.consolidate import consolidate as do_consolidate
    stats = do_consolidate(dry_run=dry_run, concurrency=concurrency, no_drop=no_drop)
    for k, v in stats.items():
        console.print(f"  {k}: {v}")


@main.command()
def clean():
    """Remove blocklisted providers (e.g. Pluto TV) and reorder streams (tvpass first)."""
    from harvester.clean import clean as do_clean
    stats = do_clean()
    console.print(
        f"[bold]Removed[/] {stats['stream_removed']} from stream files, "
        f"{stats['meta_removed']} from meta, {stats['catalog_removed']} from catalog"
    )
    console.print(
        f"Rewrote {stats['stream_files_rewritten']} stream + "
        f"{stats['meta_files_rewritten']} meta files (tvpass sorted first)"
    )


@main.command("tvpass-discover")
@click.option("--probe", is_flag=True, default=False,
              help="Scrape the tvpass directory, read each channel's real stream slug, and inject live links (rate-limit friendly; no ffprobe).")
@click.option("--delay", type=float, default=5.0, help="Seconds between tvpass requests (tvpass throttles bursts).")
@click.option("--test", is_flag=True, default=False,
              help="Probe generated candidates with ffprobe and inject working tvpass links (deeper, slower).")
@click.option("--timeout", type=float, default=DEFAULT_TIMEOUT)
@click.option("--concurrency", type=int, default=DEFAULT_TEST_CONCURRENCY)
def tvpass_discover(probe, delay, test, timeout, concurrency):
    """Find channels missing a tvpass.org link; --probe scrapes the directory for real slugs, --test ffprobes generated candidates."""
    if probe:
        from harvester.tvpass import discover_directory
        stats = discover_directory(delay=delay)
    else:
        from harvester.tvpass import discover
        stats = discover(test=test, timeout=timeout, concurrency=concurrency)
    for k, v in stats.items():
        console.print(f"  {k}: {v}")


@main.command()
@click.option("--sources-file", type=click.Path(exists=True), default=str(SOURCES_FILE))
@click.option("--filter-type", type=click.Choice(["github", "website", "telegram", "paste", "direct", "famelack"]))
@click.option("--filter-name", type=str, default=None)
@click.option("--timeout", type=float, default=DEFAULT_TIMEOUT)
@click.option("--harvest-concurrency", type=int, default=DEFAULT_HARVEST_CONCURRENCY)
@click.option("--test-concurrency", type=int, default=DEFAULT_TEST_CONCURRENCY)
@click.option("--resume/--no-resume", default=True)
def run(sources_file, filter_type, filter_name, timeout, harvest_concurrency, test_concurrency, resume):
    """Execute harvest + test + report in sequence."""
    sources = _load_sources(Path(sources_file), filter_type, filter_name)
    if not sources:
        console.print("[red]No sources matched filters[/]")
        return

    async def pipeline():
        streams = await _harvest(sources, harvest_concurrency, resume)
        results = await _test(streams, timeout, test_concurrency, resume)

        from harvester.inject import inject
        console.print("\n[bold]Injecting working streams into catalog...[/]")
        stats = inject()
        console.print(f"  Channels updated: {stats['channels_updated']}, Streams added: {stats['streams_added']}")

        rep = generate_report(results, sources_total=len(sources))
        save_report(rep)
        print_summary(rep)

    asyncio.run(pipeline())
