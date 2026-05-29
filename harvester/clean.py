"""Purge blocklisted providers and reorder streams across all addon data files.

Removes any stream whose URL is blocklisted (e.g. Pluto TV — no longer accessible,
see BLOCKLIST_URL_SUBSTRINGS in config) and sorts the remaining streams so the most
stable providers (tvpass.org first, see PROVIDER_PRIORITY) lead each channel's list.

The per-channel files under stream/tv/ are the authoritative source of streams (the
catalog carries empty inline arrays by design), so they are cleaned independently of
the catalog. Run on the host:  uv run python -m harvester clean
"""
from __future__ import annotations

import json
from pathlib import Path

from harvester.config import is_blocked, provider_rank

BASE = Path(__file__).resolve().parent.parent
CATALOG_PATH = BASE / "catalog" / "tv" / "all.json"
GENRE_DIR = BASE / "catalog" / "tv" / "all"
META_DIR = BASE / "meta" / "tv"
STREAM_DIR = BASE / "stream" / "tv"


def _clean_streams(streams: list[dict]) -> tuple[list[dict], int]:
    """Return (non-blocked streams sorted by provider priority, removed_count)."""
    streams = streams or []
    kept = [s for s in streams if not is_blocked(s.get("url", ""))]
    removed = len(streams) - len(kept)
    # Stable sort: prioritized providers first, original order preserved within a tier.
    kept = sorted(kept, key=lambda s: provider_rank(s.get("url", "")))
    return kept, removed


def clean() -> dict:
    stats = {
        "catalog_removed": 0,
        "meta_removed": 0,
        "stream_removed": 0,
        "meta_files_rewritten": 0,
        "stream_files_rewritten": 0,
    }

    # 1. Catalog inline streams + regenerate genre slices ------------------
    catalog = json.loads(CATALOG_PATH.read_text())
    for ch in catalog.get("metas", []):
        cleaned, removed = _clean_streams(ch.get("streams", []))
        ch["streams"] = cleaned
        stats["catalog_removed"] += removed
    CATALOG_PATH.write_text(json.dumps(catalog, separators=(",", ":")))

    genre_channels: dict[str, list] = {}
    for ch in catalog.get("metas", []):
        genre = ch.get("genre", "")
        if genre:
            genre_channels.setdefault(genre, []).append(ch)
    GENRE_DIR.mkdir(parents=True, exist_ok=True)
    for genre, chs in genre_channels.items():
        (GENRE_DIR / f"genre={genre}.json").write_text(
            json.dumps({"metas": chs}, separators=(",", ":"))
        )

    # 2. Per-channel meta files (inline streams) ---------------------------
    for mf in sorted(META_DIR.glob("*.json")):
        data = json.loads(mf.read_text())
        meta = data.get("meta", {})
        original = meta.get("streams", [])
        cleaned, removed = _clean_streams(original)
        if cleaned != original:
            meta["streams"] = cleaned
            mf.write_text(json.dumps({"meta": meta}, separators=(",", ":")))
            stats["meta_files_rewritten"] += 1
        stats["meta_removed"] += removed

    # 3. Per-channel stream files (authoritative stream source) ------------
    for sf in sorted(STREAM_DIR.glob("*.json")):
        data = json.loads(sf.read_text())
        original = data.get("streams", [])
        cleaned, removed = _clean_streams(original)
        if cleaned != original:
            sf.write_text(json.dumps({"streams": cleaned}, separators=(",", ":")))
            stats["stream_files_rewritten"] += 1
        stats["stream_removed"] += removed

    return stats


if __name__ == "__main__":
    s = clean()
    print(
        f"Removed {s['stream_removed']} from stream files, "
        f"{s['meta_removed']} from meta, {s['catalog_removed']} from catalog. "
        f"Rewrote {s['stream_files_rewritten']} stream + {s['meta_files_rewritten']} meta files."
    )
