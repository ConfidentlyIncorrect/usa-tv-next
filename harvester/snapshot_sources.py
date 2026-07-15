"""Download reproducible local snapshots of configured and legacy source endpoints."""
from __future__ import annotations

import asyncio
import hashlib
import json
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

import aiohttp
import yaml

from harvester.config import BASE_DIR, SOURCES_FILE, USER_AGENTS
from harvester.models import SourceConfig, SourceType

LEGACY_SOURCES_FILE = BASE_DIR.parent / "sources.txt"


@dataclass
class SnapshotTarget:
    url: str
    source_ids: list[str] = field(default_factory=list)


def source_url(config: SourceConfig) -> str:
    """Return the public endpoint to snapshot for a source definition."""
    if config.type == SourceType.GITHUB:
        return f"https://github.com/{config.repo}"
    if config.type == SourceType.TELEGRAM:
        return f"https://t.me/s/{config.channel}"
    return config.url


def load_targets(include_configured: bool = True, include_legacy: bool = True) -> list[SnapshotTarget]:
    by_url: dict[str, SnapshotTarget] = {}

    def add(url: str, source_id: str) -> None:
        url = (url or "").strip()
        if not url.startswith(("http://", "https://")):
            return
        target = by_url.setdefault(url, SnapshotTarget(url=url))
        if source_id not in target.source_ids:
            target.source_ids.append(source_id)

    if include_configured:
        raw = yaml.safe_load(SOURCES_FILE.read_text(encoding="utf-8")) or {}
        for item in raw.get("sources", []):
            config = SourceConfig(**item)
            add(source_url(config), config.source_id())

    if include_legacy and LEGACY_SOURCES_FILE.exists():
        for index, url in enumerate(LEGACY_SOURCES_FILE.read_text(encoding="utf-8").splitlines(), 1):
            add(url, f"legacy:{index}")

    return list(by_url.values())


def _extension(content_type: str, url: str) -> str:
    content_type = (content_type or "").lower()
    path_suffix = Path(urlparse(url).path).suffix.lower()
    if "json" in content_type or path_suffix == ".json":
        return ".json"
    if "mpegurl" in content_type or path_suffix in {".m3u", ".m3u8"}:
        return path_suffix if path_suffix in {".m3u", ".m3u8"} else ".m3u"
    if "html" in content_type:
        return ".html"
    if content_type.startswith("text/"):
        return ".txt"
    return path_suffix if path_suffix and len(path_suffix) <= 8 else ".bin"


def _slug(target: SnapshotTarget) -> str:
    label = target.source_ids[0] if target.source_ids else urlparse(target.url).netloc
    return re.sub(r"[^a-zA-Z0-9._-]+", "-", label).strip("-")[:100] or "source"


async def snapshot(
    output_dir: Path,
    include_configured: bool = True,
    include_legacy: bool = True,
    concurrency: int = 6,
    max_bytes: int = 12 * 1024 * 1024,
) -> dict:
    targets = load_targets(include_configured, include_legacy)
    output_dir.mkdir(parents=True, exist_ok=True)
    sem = asyncio.Semaphore(concurrency)
    timeout = aiohttp.ClientTimeout(total=45, connect=12, sock_read=25)
    headers = {"User-Agent": USER_AGENTS[1], "Accept": "*/*"}

    async with aiohttp.ClientSession(timeout=timeout, headers=headers) as session:
        async def fetch(index: int, target: SnapshotTarget) -> dict:
            row = {
                "url": target.url,
                "source_ids": target.source_ids,
                "status": 0,
                "final_url": "",
                "content_type": "",
                "bytes": 0,
                "sha256": "",
                "file": None,
                "truncated": False,
                "error": "",
            }
            async with sem:
                try:
                    async with session.get(target.url, allow_redirects=True) as response:
                        row["status"] = response.status
                        row["final_url"] = str(response.url)
                        row["content_type"] = response.headers.get("Content-Type", "")
                        body = bytearray()
                        async for chunk in response.content.iter_chunked(64 * 1024):
                            remaining = max_bytes - len(body)
                            if remaining <= 0:
                                row["truncated"] = True
                                break
                            body.extend(chunk[:remaining])
                            if len(chunk) > remaining:
                                row["truncated"] = True
                                break
                        if body:
                            ext = _extension(row["content_type"], row["final_url"] or target.url)
                            filename = f"{index:03d}-{_slug(target)}{ext}"
                            (output_dir / filename).write_bytes(body)
                            row["file"] = filename
                            row["bytes"] = len(body)
                            row["sha256"] = hashlib.sha256(body).hexdigest()
                except Exception as exc:  # each source is independent; retain the failure in manifest
                    row["error"] = f"{type(exc).__name__}: {exc}"
            return row

        rows = await asyncio.gather(*(fetch(i, target) for i, target in enumerate(targets, 1)))

    manifest = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "configured_sources_file": str(SOURCES_FILE),
        "legacy_sources_file": str(LEGACY_SOURCES_FILE),
        "targets": len(rows),
        "downloaded": sum(bool(row["file"]) for row in rows),
        "http_success": sum(200 <= row["status"] < 300 for row in rows),
        "rows": rows,
    }
    (output_dir / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return manifest
