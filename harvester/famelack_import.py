"""Import NEW channels from famelack into the catalog (curated/test import).

Filters famelack US channels by a name keyword, then:
  - drops geo-blocked channels and channels that duplicate an existing catalog
    channel OR another channel in the batch (normalized name),
  - ffprobe-validates each candidate's stream_urls and imports only channels with
    >= 1 working stream,
  - generates a `ustv-<uuid>` id and writes catalog + genre + meta + stream files,
  - assigns the given genre and art (a suitable repo logo/poster if `--logo` is given,
    else iptv-org via harvester.logos).

Never duplicates an existing channel. Host:
    uv run python -m harvester famelack-import --keyword telemundo --genre Latino --logo telemundo-us
"""
from __future__ import annotations

import asyncio
import gzip
import json
import unicodedata
import urllib.request
import uuid
from pathlib import Path

from harvester.config import DEFAULT_TEST_CONCURRENCY, DEFAULT_TIMEOUT, provider_rank
from harvester.inject import _normalize, _quality_label
from harvester.models import ParsedStream, StreamStatus
from harvester.tester import test_streams

BASE = Path(__file__).resolve().parent.parent
CATALOG = BASE / "catalog" / "tv" / "all.json"
GENRE_DIR = BASE / "catalog" / "tv" / "all"
META_DIR = BASE / "meta" / "tv"
STREAM_DIR = BASE / "stream" / "tv"
PUBLIC = BASE / "public"
# Art host matches the URLs already used throughout the catalog.
ART_HOST = "https://raw.githubusercontent.com/yowmamasita/usa-tv-next/main"
FAMELACK_US = "https://raw.githubusercontent.com/famelack/famelack-data/main/tv/compressed/countries/us.json"
_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"


def _key(name: str) -> str:
    """Dedup key: fold accents (Al Día == Al Dia) then normalize."""
    folded = unicodedata.normalize("NFKD", name or "").encode("ascii", "ignore").decode()
    return _normalize(folded)


def _fetch_famelack() -> list[dict]:
    req = urllib.request.Request(FAMELACK_US, headers={"User-Agent": _UA})
    with urllib.request.urlopen(req, timeout=40) as r:
        raw = r.read()
    try:
        raw = gzip.decompress(raw)
    except Exception:
        pass
    return json.loads(raw.decode("utf-8", "ignore"))


def _art(name: str, logo_slug: str | None) -> tuple[str, str]:
    """(logo_url, poster_url). Prefer a repo file if logo_slug points to one; else iptv-org logo."""
    if logo_slug:
        lf = PUBLIC / "logos" / "usa" / f"{logo_slug}.png"
        pf = PUBLIC / "posters" / "usa" / f"{logo_slug}.png"
        if lf.exists():
            logo = f"{ART_HOST}/public/logos/usa/{logo_slug}.png"
            poster = f"{ART_HOST}/public/posters/usa/{logo_slug}.png" if pf.exists() else logo
            return logo, poster
    try:
        from harvester.logos import resolve_logo
        url = resolve_logo(name)
        if url:
            return url, url
    except Exception:
        pass
    fallback = f"{ART_HOST}/public/logo.png"
    return fallback, fallback


async def _run(keyword: str, genre: str, logo_slug: str | None, timeout: float, concurrency: int) -> dict:
    catalog = json.loads(CATALOG.read_text(encoding="utf-8"))
    metas = catalog["metas"]
    existing_norms = {_key(c["name"]) for c in metas}

    kw = keyword.lower()
    seen_batch: set[str] = set()
    candidates: list[dict] = []  # {name, urls}
    for ch in _fetch_famelack():
        if kw not in (ch.get("name") or "").lower():
            continue
        if ch.get("isGeoBlocked"):
            continue
        name = ch["name"].strip()
        n = _key(name)
        if n in existing_norms or n in seen_batch:
            continue  # dedup vs catalog + intra-batch
        urls = [u for u in (ch.get("stream_urls") or []) if isinstance(u, str) and u.startswith("http")]
        if not urls:
            continue
        seen_batch.add(n)
        candidates.append({"name": name, "urls": urls})

    print(f"candidates after keyword/geo/dedup: {len(candidates)}")
    for c in candidates:
        print(f"  - {c['name']} ({len(c['urls'])} url)")

    # ffprobe-validate
    pairs = [(c["name"], u) for c in candidates for u in c["urls"]]
    streams = [ParsedStream(url=u, channel_name=nm) for nm, u in pairs]
    results = await test_streams(streams, timeout=timeout, concurrency=concurrency)
    res = {r.url: r for r in results}
    working = {r.url for r in results if r.status == StreamStatus.WORKING}
    print(f"working streams: {len(working)} of {len(pairs)}")

    imported = []
    for c in candidates:
        good = [u for u in c["urls"] if u in working]
        if not good:
            print(f"  skip (no working stream): {c['name']}")
            continue
        cid = f"ustv-{uuid.uuid4()}"
        logo, poster = _art(c["name"], logo_slug)
        entry = {
            "id": cid, "tvgId": "", "name": c["name"], "country": "USA", "countryCode": "us",
            "genre": genre, "logo": logo, "time": None, "type": "tv",
            "poster": poster, "genres": [genre], "streams": [],
        }
        stream_entries = []
        for u in good:
            r = res.get(u)
            q = _quality_label({"codecs": {"resolution": r.codecs.resolution, "video": r.codecs.video}} if r else {})
            stream_entries.append({"url": u, "behaviorHints": {"notWebReady": True}, "name": q, "description": "FL"})
        stream_entries.sort(key=lambda s: provider_rank(s.get("url", "")))
        metas.append(entry)
        META_DIR.mkdir(parents=True, exist_ok=True)
        STREAM_DIR.mkdir(parents=True, exist_ok=True)
        (META_DIR / f"{cid}.json").write_text(json.dumps({"meta": entry}, separators=(",", ":")), encoding="utf-8")
        (STREAM_DIR / f"{cid}.json").write_text(json.dumps({"streams": stream_entries}, separators=(",", ":")), encoding="utf-8")
        imported.append((c["name"], cid, len(stream_entries)))
        print(f"  IMPORTED {c['name']} -> {cid} ({len(stream_entries)} stream)")

    if imported:
        CATALOG.write_text(json.dumps(catalog, separators=(",", ":")), encoding="utf-8")
        # regenerate the affected genre slice
        genre_chs = [c for c in metas if c.get("genre") == genre]
        GENRE_DIR.mkdir(parents=True, exist_ok=True)
        (GENRE_DIR / f"genre={genre}.json").write_text(json.dumps({"metas": genre_chs}, separators=(",", ":")), encoding="utf-8")

    return {"candidates": len(candidates), "working_streams": len(working),
            "channels_imported": len(imported), "catalog_total": len(metas)}


def import_channels(keyword: str, genre: str, logo_slug: str | None = None,
                    timeout: float = DEFAULT_TIMEOUT, concurrency: int = DEFAULT_TEST_CONCURRENCY) -> dict:
    return asyncio.run(_run(keyword, genre, logo_slug, timeout, concurrency))


if __name__ == "__main__":
    print(import_channels("telemundo", "Latino", "telemundo-us"))
