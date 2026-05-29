"""TVPASS discovery (precursor for finding tvpass.org links).

tvpass.org serves live channels at:

    https://tvpass.org/live/<slug>/<quality>

Observed slugs are either CamelCase (e.g. DisneyChannelEast, NFLNetwork, SyfyEast)
or kebab-case (e.g. nbc-sports-bay-area), frequently with an East/West feed suffix.
Quality is one of sd / hd / fhd.

This module:
  1. Finds catalog channels that do NOT yet have a tvpass.org stream.
  2. Generates candidate tvpass URLs for each (the "precursor" — no network needed),
     written to data/tvpass_candidates.json for review.
  3. With test=True (host only — needs ffprobe), probes the candidates and injects the
     working ones into the per-channel stream files + catalog, tagged "TP" and sorted
     to the top (tvpass is the prioritized provider).

Host usage:
    uv run python -m harvester tvpass-discover            # generate candidates only
    uv run python -m harvester tvpass-discover --test     # probe + inject working ones
"""
from __future__ import annotations

import asyncio
import json
import re
from pathlib import Path

from harvester.config import DEFAULT_TEST_CONCURRENCY, DEFAULT_TIMEOUT, provider_rank

BASE = Path(__file__).resolve().parent.parent
CATALOG_PATH = BASE / "catalog" / "tv" / "all.json"
GENRE_DIR = BASE / "catalog" / "tv" / "all"
META_DIR = BASE / "meta" / "tv"
STREAM_DIR = BASE / "stream" / "tv"
DATA_DIR = BASE / "data"

TVPASS_HOST = "tvpass.org"
TVPASS_TEMPLATE = "https://tvpass.org/live/{slug}/{quality}"
QUALITIES = ["fhd", "hd", "sd"]  # best-first; first working wins per channel

_QUALITY_LABEL = {"fhd": "FHD", "hd": "HD", "sd": "SD"}


# --- slug / candidate generation ------------------------------------------

def _camel(name: str) -> str:
    words = re.findall(r"[A-Za-z0-9]+", name)
    return "".join(w[:1].upper() + w[1:] for w in words)


def _kebab(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def candidate_slugs(name: str) -> list[str]:
    """Plausible tvpass slugs for a channel name, best guesses first."""
    camel = _camel(name)
    kebab = _kebab(name)
    out: list[str] = []
    if camel:
        out += [camel, camel + "East", camel + "West", camel + "HD"]
    if kebab and kebab != camel.lower():
        out += [kebab, kebab + "-east", kebab + "-west"]
    seen: set[str] = set()
    deduped: list[str] = []
    for s in out:
        if s not in seen:
            seen.add(s)
            deduped.append(s)
    return deduped


def candidate_urls(name: str) -> list[str]:
    return [
        TVPASS_TEMPLATE.format(slug=s, quality=q)
        for s in candidate_slugs(name)
        for q in QUALITIES
    ]


# --- channel inspection ----------------------------------------------------

def _channel_streams(ch: dict) -> list[dict]:
    """Streams for a channel: inline if present, else the per-channel stream file."""
    inline = ch.get("streams") or []
    if inline:
        return inline
    sf = STREAM_DIR / f"{ch['id']}.json"
    if sf.exists():
        try:
            return json.loads(sf.read_text()).get("streams", []) or []
        except Exception:
            return []
    return []


def _has_tvpass(streams: list[dict]) -> bool:
    return any(TVPASS_HOST in (s.get("url", "") or "") for s in streams)


def channels_missing_tvpass() -> list[dict]:
    catalog = json.loads(CATALOG_PATH.read_text())
    return [ch for ch in catalog.get("metas", []) if not _has_tvpass(_channel_streams(ch))]


# --- precursor: write candidate list --------------------------------------

def generate(out_path: Path | None = None) -> dict:
    catalog = json.loads(CATALOG_PATH.read_text())
    total = len(catalog.get("metas", []))
    missing = channels_missing_tvpass()
    payload = [
        {"id": ch["id"], "name": ch["name"], "candidates": candidate_urls(ch["name"])}
        for ch in missing
    ]
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    out = out_path or (DATA_DIR / "tvpass_candidates.json")
    out.write_text(json.dumps(payload, indent=2))
    return {
        "channels_total": total,
        "channels_with_tvpass": total - len(missing),
        "channels_missing_tvpass": len(missing),
        "candidate_urls": sum(len(p["candidates"]) for p in payload),
        "output": str(out),
    }


# --- injection helpers -----------------------------------------------------

def _quality_from_url(url: str) -> str:
    tail = url.rstrip("/").rsplit("/", 1)[-1].lower()
    return _QUALITY_LABEL.get(tail, "HD")


def _tvpass_entry(url: str) -> dict:
    return {
        "url": url,
        "behaviorHints": {"notWebReady": True},
        "name": _quality_from_url(url),
        "description": "TP",
    }


def _write_streams_for_channel(ch_id: str, new_urls: list[str]) -> int:
    """Add tvpass entries to a channel's stream file (dedup) and sort tvpass-first."""
    sf = STREAM_DIR / f"{ch_id}.json"
    streams = []
    if sf.exists():
        try:
            streams = json.loads(sf.read_text()).get("streams", []) or []
        except Exception:
            streams = []
    existing = {s.get("url") for s in streams}
    added = 0
    for url in new_urls:
        if url not in existing:
            streams.append(_tvpass_entry(url))
            existing.add(url)
            added += 1
    streams.sort(key=lambda s: provider_rank(s.get("url", "")))
    sf.write_text(json.dumps({"streams": streams}, separators=(",", ":")))
    return added


# --- discovery (host only — needs ffprobe) ---------------------------------

async def _discover_async(timeout: float, concurrency: int) -> dict:
    from harvester.models import ParsedStream
    from harvester.tester import test_streams

    missing = channels_missing_tvpass()
    pairs: list[tuple[str, str]] = []  # (channel_id, url)
    for ch in missing:
        for url in candidate_urls(ch["name"]):
            pairs.append((ch["id"], url))

    streams = [ParsedStream(url=url, channel_name=cid) for cid, url in pairs]
    results = await test_streams(streams, timeout=timeout, concurrency=concurrency)
    working = {r.url for r in results if getattr(r.status, "value", r.status) == "working"}

    by_channel: dict[str, list[str]] = {}
    for cid, url in pairs:
        if url in working:
            by_channel.setdefault(cid, []).append(url)

    channels_updated = 0
    streams_added = 0
    for cid, urls in by_channel.items():
        added = _write_streams_for_channel(cid, urls)
        if added:
            channels_updated += 1
            streams_added += added

    return {
        "candidates_tested": len(pairs),
        "candidates_working": len(working),
        "channels_updated": channels_updated,
        "streams_added": streams_added,
    }


def discover(test: bool = False, timeout: float = DEFAULT_TIMEOUT,
             concurrency: int = DEFAULT_TEST_CONCURRENCY) -> dict:
    gen = generate()
    if not test:
        return gen
    found = asyncio.run(_discover_async(timeout, concurrency))
    return {**gen, **found}


if __name__ == "__main__":
    print(generate())
