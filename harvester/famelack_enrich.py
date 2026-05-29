"""Enrich the existing catalog channels with famelack streams.

Unlike a blind import, this only ADDS streams to channels we already have (matched by
name via inject's tested matcher), ffprobe-validates each candidate, and writes the
working ones into the per-channel stream files (deduped by URL, sorted so tvpass leads).
Never creates catalog channels. Tagged "FL".

Host:  uv run python -m harvester famelack-enrich
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import aiohttp

from harvester.config import DEFAULT_TEST_CONCURRENCY, DEFAULT_TIMEOUT, provider_rank
from harvester.inject import _match_streams, _normalize, _quality_label
from harvester.models import ParsedStream, SourceConfig, SourceType, StreamStatus
from harvester.sources.famelack import FamelackSource
from harvester.tester import test_streams

BASE = Path(__file__).resolve().parent.parent
CATALOG = BASE / "catalog" / "tv" / "all.json"
STREAM_DIR = BASE / "stream" / "tv"


def _channel_streams(cid: str) -> list[dict]:
    f = STREAM_DIR / f"{cid}.json"
    if f.exists():
        try:
            return json.loads(f.read_text(encoding="utf-8")).get("streams", [])
        except Exception:
            return []
    return []


async def _run(timeout: float, concurrency: int) -> dict:
    # 1. fetch famelack streams
    cfg = SourceConfig(type=SourceType.FAMELACK, name="famelack-us")
    async with aiohttp.ClientSession() as session:
        parsed = await FamelackSource(cfg).fetch(session)
    print(f"famelack streams fetched: {len(parsed)}")

    # 2. match to ALL catalog channels (reuse inject's matcher)
    catalog = json.loads(CATALOG.read_text(encoding="utf-8"))
    channels = catalog["metas"]
    catalog_norms = {_normalize(c["name"]) for c in channels}
    working_like = [{"url": p.url, "channel_name": p.channel_name} for p in parsed]
    matches = _match_streams(channels, working_like, catalog_norms)  # {cid: [dicts]}
    pairs = [(cid, r["url"]) for cid, rs in matches.items() for r in rs]
    print(f"matched {len(pairs)} candidate streams across {len(matches)} channels")

    # 3. ffprobe-test the matched candidates
    streams = [ParsedStream(url=u, channel_name=cid) for cid, u in pairs]
    results = await test_streams(streams, timeout=timeout, concurrency=concurrency)
    res_by_url = {r.url: r for r in results}
    working = {r.url for r in results if r.status == StreamStatus.WORKING}
    print(f"working: {len(working)} of {len(pairs)}")

    # 4. inject working into the per-channel stream files
    chans = added = 0
    for cid, rs in matches.items():
        good = [r["url"] for r in rs if r["url"] in working]
        if not good:
            continue
        existing = _channel_streams(cid)
        seen = {s.get("url") for s in existing}
        n0 = len(existing)
        for url in good:
            if url in seen:
                continue
            r = res_by_url.get(url)
            q = _quality_label({"codecs": {"resolution": r.codecs.resolution, "video": r.codecs.video}} if r else {})
            existing.append({"url": url, "behaviorHints": {"notWebReady": True}, "name": q, "description": "FL"})
            seen.add(url)
        from harvester.regional import order_streams
        existing, _ = order_streams(existing)  # regional priority + true-dup collapse
        (STREAM_DIR / f"{cid}.json").write_text(json.dumps({"streams": existing}, separators=(",", ":")), encoding="utf-8")
        delta = len(existing) - n0
        if delta:
            chans += 1
            added += delta
    return {"famelack_streams": len(parsed), "matched_candidates": len(pairs),
            "working": len(working), "channels_enriched": chans, "streams_added": added}


def enrich(timeout: float = DEFAULT_TIMEOUT, concurrency: int = DEFAULT_TEST_CONCURRENCY) -> dict:
    return asyncio.run(_run(timeout, concurrency))


if __name__ == "__main__":
    print(enrich())
