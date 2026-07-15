"""Famelack source — famelack.com publishes its entire TV dataset as gzipped JSON in
a public GitHub repo (famelack/famelack-data), so we read it directly rather than
scraping the Cloudflare-fronted SPA.

US data: tv/compressed/countries/us.json (gzip), a list of channels shaped:
    {"nanoid": "...", "name": "3ABN English",
     "sources": {"streams": ["https://.../playlist.m3u8"]},
     "languages": ["eng"], "country": "us", "isGeoBlocked": false}

Older snapshots used top-level ``stream_urls``.  Accept both forms so source snapshots
remain comparable and an upstream schema migration cannot silently produce zero streams.

We yield one ParsedStream per (channel, direct stream_url) so the normal
harvest -> test (ffprobe) -> inject pipeline matches them to catalog channels by name.
youtube_urls are skipped (they'd need yt-dlp resolution, not a direct stream).

Config (sources.yaml):
    - type: famelack
      name: famelack-us
      url: https://raw.githubusercontent.com/famelack/famelack-data/main/tv/compressed/countries/us.json
      strategy: include_geoblocked   # optional; default drops isGeoBlocked channels
"""
from __future__ import annotations

import gzip
import json
import random

import aiohttp

from harvester.config import USER_AGENTS
from harvester.models import ParsedStream
from harvester.sources.base import BaseSource

DEFAULT_URL = (
    "https://raw.githubusercontent.com/famelack/famelack-data/main/"
    "tv/compressed/countries/us.json"
)


def channel_stream_urls(channel: dict) -> list[str]:
    """Return direct stream URLs from the current or legacy Famelack schema."""
    current = (channel.get("sources") or {}).get("streams") or []
    legacy = channel.get("stream_urls") or []
    values = current or legacy
    return [u for u in values if isinstance(u, str) and u.startswith("http")]


class FamelackSource(BaseSource):
    async def fetch(self, session: aiohttp.ClientSession) -> list[ParsedStream]:
        url = self.config.url or DEFAULT_URL
        headers = {"User-Agent": random.choice(USER_AGENTS)}
        try:
            async with session.get(url, headers=headers, timeout=aiohttp.ClientTimeout(total=30)) as resp:
                if resp.status != 200:
                    return []
                raw = await resp.read()
        except (aiohttp.ClientError, TimeoutError):
            return []

        # Files carry a .json extension but are gzip-compressed.
        try:
            raw = gzip.decompress(raw)
        except (OSError, EOFError):
            pass

        try:
            channels = json.loads(raw.decode("utf-8", "ignore"))
        except (ValueError, TypeError):
            return []
        if not isinstance(channels, list):
            return []

        include_geo = (self.config.strategy or "").lower() == "include_geoblocked"
        sid = self.config.source_id()
        out: list[ParsedStream] = []
        for ch in channels:
            if not isinstance(ch, dict):
                continue
            if ch.get("isGeoBlocked") and not include_geo:
                continue
            name = (ch.get("name") or "").strip()
            if not name:
                continue
            for u in channel_stream_urls(ch):
                out.append(ParsedStream(url=u, channel_name=name, source_id=sid))
        return out
