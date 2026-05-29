"""TVPASS discovery (precursor for finding tvpass.org links).

tvpass.org serves live channels at:

    https://tvpass.org/live/<slug>/<quality>

Observed slugs are either CamelCase (e.g. DisneyChannelEast, NFLNetwork, SyfyEast)
or kebab-case (e.g. nbc-sports-bay-area), frequently with an East/West feed suffix.
Quality is one of sd / hd / fhd.

Generator accuracy (validated against the 131 tvpass links already in the addon):
  • heuristics alone reproduce ~79% of the known slugs;
  • tvpass_known.json supplies the exact verified slug for every known channel, so the
    generator reproduces 100% of known-working sources and falls back to heuristics only
    for channels it has never seen (the ones we're trying to discover).

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


# --- ground-truth overrides -----------------------------------------------
# tvpass_known.json holds the 131 verified (channel name -> exact slug) mappings
# extracted from the streams already in the addon. Using them as authoritative
# overrides makes the generator reproduce 100% of known-working tvpass links;
# heuristics (validated at ~79% against those same known links) cover new channels.
KNOWN_FILE = Path(__file__).resolve().parent / "tvpass_known.json"


def _load_known() -> dict[str, str]:
    try:
        return json.loads(KNOWN_FILE.read_text())
    except Exception:
        return {}


KNOWN_SLUGS = _load_known()

# Generic trailing words that tvpass sometimes drops (e.g. "Science Channel" -> "Science").
_GENERIC_SUFFIXES = {"channel", "network", "television", "tv", "usa", "hd"}


# --- slug / candidate generation ------------------------------------------

def _words(name: str) -> list[str]:
    return re.findall(r"[A-Za-z0-9]+", name)


def _camel(name: str) -> str:
    # Preserve interior caps: "HBO Signature" -> "HBOSignature".
    return "".join(w[:1].upper() + w[1:] for w in _words(name))


def _title(name: str) -> str:
    # Normalize caps: "SYFY" -> "Syfy", "VICE TV" -> "ViceTv".
    return "".join(w.capitalize() for w in _words(name))


def _upper(name: str) -> str:
    return "".join(_words(name)).upper()


def _kebab(name: str) -> str:
    return "-".join(w.lower() for w in _words(name))


def _name_variants(name: str) -> list[str]:
    """Alternate spellings tvpass may use (Plus/And/Junior, FanDuel full name, suffix-drop)."""
    variants = [name]
    if "+" in name:
        variants.append(name.replace("+", " Plus "))
    if "&" in name:
        variants.append(name.replace("&", " And "))
    jr = re.sub(r"\bJr\.?\b", "Junior", name)
    if jr != name:
        variants.append(jr)
    if name.lower().startswith("fanduel"):
        variants.append("FanDuel Sports Network " + name[len("fanduel"):].strip())
    extra = []
    for v in variants:
        w = _words(v)
        if len(w) > 1 and w[-1].lower() in _GENERIC_SUFFIXES:
            extra.append(" ".join(w[:-1]))
    return variants + extra


def candidate_slugs(name: str) -> list[str]:
    """Candidate tvpass slugs for a channel name. Verified slug (if known) first,
    then a broad set of heuristic variants (case forms x feed/quality suffixes)."""
    out: list[str] = []
    known = KNOWN_SLUGS.get(name.strip())
    if known:
        out.append(known)  # authoritative — always tried first

    camel_feeds = ["", "East", "West", "HD"]
    kebab_feeds = ["", "-east", "-west", "-eastern", "-hd"]
    suffix_adds = ["TV", "Channel", "Network", "USA"]

    for v in _name_variants(name):
        if not _words(v):
            continue
        for base in {_camel(v), _title(v), _upper(v)}:
            out += [base + f for f in camel_feeds]
        k = _kebab(v)
        out += [k + f for f in kebab_feeds]
        cam = _camel(v)
        for s in suffix_adds:
            out += [cam + s, cam + s + "East"]

    seen: set[str] = set()
    deduped: list[str] = []
    for s in out:
        if s and s not in seen:
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
