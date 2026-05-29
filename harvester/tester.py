from __future__ import annotations

import asyncio
import json
import re
import socket
import time
from collections import defaultdict
from datetime import datetime, timezone
from urllib.parse import urlparse

from rich.progress import Progress, SpinnerColumn, BarColumn, TextColumn, MofNCompleteColumn

from harvester.models import CodecInfo, ParsedStream, StreamStatus, StreamTestResult


async def _resolve_host(host: str, timeout: float = 3.0) -> bool:
    loop = asyncio.get_event_loop()
    try:
        await asyncio.wait_for(
            loop.run_in_executor(None, socket.getaddrinfo, host, None),
            timeout=timeout,
        )
        return True
    except Exception:
        return False


_FFPROBE_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
)

# HLS video codec fourccs seen in #EXT-X-STREAM-INF CODECS=... attributes.
_HLS_VIDEO_CODECS = ("avc1", "avc3", "hev1", "hvc1", "hevc", "mp4v",
                     "vp09", "vp9", "av01", "dvh1", "dvhe", "mpeg2", "h264", "h265")


def _parse_hls_manifest(text: str) -> tuple[str, str]:
    """Parse an HLS MASTER playlist for the best (RESOLUTION, video-codec) declared in its
    #EXT-X-STREAM-INF variant tags. Returns ("WxH", "codec") with the MAX resolution, or
    ("", "") if it's a media playlist / has no variant info.

    This is the authoritative source for HLS video presence + resolution: many CDNs
    (amagi, xumo, etc.) declare CODECS="avc1...,mp4a..." + RESOLUTION here even when
    ffprobe -show_streams fails to enumerate the heavily-tokenized variant and wrongly
    reports zero streams (which made real video look audio-only)."""
    best_w = best_h = 0
    codec = ""
    for attrs in re.findall(r"#EXT-X-STREAM-INF:([^\r\n]*)", text):
        mres = re.search(r"RESOLUTION=(\d+)x(\d+)", attrs)
        mcod = re.search(r'CODECS="([^"]*)"', attrs)
        has_video = bool(mres) or (mcod and any(c in mcod.group(1).lower() for c in _HLS_VIDEO_CODECS))
        if mres:
            w, h = int(mres.group(1)), int(mres.group(2))
            if w * h > best_w * best_h:
                best_w, best_h = w, h
        if has_video and not codec:
            if mcod:
                first = mcod.group(1).split(",")[0].split(".")[0].lower()
                codec = next((c for c in _HLS_VIDEO_CODECS if c in first), "h264")
            else:
                codec = "h264"
    return (f"{best_w}x{best_h}" if best_w else ""), codec


def _fetch_text(url: str, timeout: float) -> str:
    import urllib.request
    req = urllib.request.Request(url, headers={"User-Agent": _FFPROBE_UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read(2_000_000).decode("utf-8", "ignore")  # cap at 2 MB


async def _hls_manifest_probe(url: str, timeout: float) -> tuple[str, str]:
    """Fallback video detection for HLS: fetch the manifest and read variant metadata.
    Returns ("WxH", "codec") or ("", ""). Never raises."""
    if ".m3u8" not in url.lower():
        return "", ""
    try:
        text = await asyncio.wait_for(asyncio.to_thread(_fetch_text, url, timeout), timeout + 3)
    except Exception:
        return "", ""
    return _parse_hls_manifest(text)


async def test_stream(url: str, timeout: float = 8.0) -> StreamTestResult:
    start = time.monotonic()
    try:
        proc = await asyncio.create_subprocess_exec(
            "ffprobe",
            "-v", "quiet",
            "-print_format", "json",
            "-show_streams",
            "-show_format",
            # Send a browser UA — some CDNs return an empty manifest to the default
            # ffmpeg/Lavf agent, which made real video streams look empty/audio-only.
            "-user_agent", _FFPROBE_UA,
            # Larger probe so HLS variant playlists reveal their video track within
            # the window (the old 500k/2s often missed video on live masters).
            "-analyzeduration", "5000000",
            "-probesize", "5000000",
            "-timeout", str(int(timeout * 1_000_000)),
            "-i", url,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout + 5)
        elapsed_ms = int((time.monotonic() - start) * 1000)

        if proc.returncode != 0:
            return StreamTestResult(
                url=url,
                status=StreamStatus.DEAD,
                response_time_ms=elapsed_ms,
                tested_at=datetime.now(timezone.utc).isoformat(),
            )

        codecs = CodecInfo()
        try:
            data = json.loads(stdout)
            best_w = best_h = 0
            for stream in data.get("streams", []):
                ctype = stream.get("codec_type")
                if ctype == "video":
                    # HLS masters list one video stream per variant — keep the largest,
                    # so the quality label reflects the best available rendition.
                    w = stream.get("width", 0) or 0
                    h = stream.get("height", 0) or 0
                    if not codecs.video:
                        codecs.video = stream.get("codec_name", "")
                    if w * h >= best_w * best_h:
                        best_w, best_h = w, h
                        if stream.get("codec_name"):
                            codecs.video = stream.get("codec_name", "")
                elif ctype == "audio" and not codecs.audio:
                    codecs.audio = stream.get("codec_name", "")
            if best_w and best_h:
                codecs.resolution = f"{best_w}x{best_h}"
            fmt = data.get("format", {})
            if fmt.get("bit_rate"):
                codecs.bitrate = fmt["bit_rate"]
        except (json.JSONDecodeError, KeyError):
            pass

        # HLS fallback: ffprobe sometimes can't enumerate a tokenized variant and reports
        # no video at all (real video then looks audio-only). The manifest declares the
        # truth — use it when ffprobe found no video, and to upgrade to the true max
        # variant resolution when the manifest advertises a higher one.
        if ".m3u8" in url.lower():
            m_res, m_codec = await _hls_manifest_probe(url, timeout)
            if m_res:
                mw = int(m_res.split("x")[0])
                cur_w = int(codecs.resolution.split("x")[0]) if "x" in codecs.resolution else 0
                if not codecs.video or mw > cur_w:
                    codecs.resolution = m_res
                    if not codecs.video:
                        codecs.video = m_codec or "h264"
            elif m_codec and not codecs.video:
                codecs.video = m_codec

        return StreamTestResult(
            url=url,
            status=StreamStatus.WORKING,
            response_time_ms=elapsed_ms,
            codecs=codecs,
            tested_at=datetime.now(timezone.utc).isoformat(),
        )

    except asyncio.TimeoutError:
        elapsed_ms = int((time.monotonic() - start) * 1000)
        return StreamTestResult(
            url=url,
            status=StreamStatus.TIMEOUT,
            response_time_ms=elapsed_ms,
            tested_at=datetime.now(timezone.utc).isoformat(),
        )
    except OSError as e:
        return StreamTestResult(
            url=url,
            status=StreamStatus.DEAD,
            response_time_ms=0,
            tested_at=datetime.now(timezone.utc).isoformat(),
            error=str(e),
        )


async def test_streams(
    streams: list[ParsedStream],
    timeout: float = 8.0,
    concurrency: int = 50,
    tested_urls: dict[str, str] | None = None,
    on_result: callable = None,
) -> list[StreamTestResult]:
    tested = tested_urls or {}
    results: list[StreamTestResult] = []

    urls_to_test = [s for s in streams if s.url not in tested]

    with Progress(
        SpinnerColumn(),
        TextColumn("[bold blue]{task.description}"),
        BarColumn(),
        MofNCompleteColumn(),
        TextColumn("[green]{task.fields[working]}W[/] [red]{task.fields[dead]}D[/] [yellow]{task.fields[timeout]}T[/]"),
    ) as progress:

        # Phase 1: DNS pre-filter — resolve unique hosts to kill dead domains in bulk
        hosts_by_stream: dict[str, str] = {}
        unique_hosts: set[str] = set()
        for s in urls_to_test:
            try:
                host = urlparse(s.url).hostname or ""
            except Exception:
                host = ""
            hosts_by_stream[s.url] = host
            if host:
                unique_hosts.add(host)

        dns_task = progress.add_task("DNS resolve", total=len(unique_hosts), working=0, dead=0, timeout=0)
        dns_sem = asyncio.Semaphore(200)
        live_hosts: set[str] = set()
        dead_host_count = 0

        async def resolve_one(host: str) -> tuple[str, bool]:
            nonlocal dead_host_count
            async with dns_sem:
                alive = await _resolve_host(host)
                if not alive:
                    dead_host_count += 1
                progress.update(dns_task, advance=1, dead=dead_host_count, working=0, timeout=0)
                return host, alive

        dns_results = await asyncio.gather(*[resolve_one(h) for h in unique_hosts])
        for host, alive in dns_results:
            if alive:
                live_hosts.add(host)

        alive_streams = []
        for s in urls_to_test:
            host = hosts_by_stream[s.url]
            if host in live_hosts:
                alive_streams.append(s)
            else:
                r = StreamTestResult(
                    url=s.url,
                    status=StreamStatus.DEAD,
                    channel_name=s.channel_name,
                    group=s.group,
                    sources=s.source_id.split(",") if s.source_id else [],
                    tested_at=datetime.now(timezone.utc).isoformat(),
                )
                results.append(r)
                if on_result:
                    on_result(r)

        progress.update(dns_task, description=(
            f"DNS done — {len(live_hosts)} hosts alive, {dead_host_count} dead, "
            f"{len(alive_streams)} streams to probe"
        ))

        # Phase 2: ffprobe
        probe_sem = asyncio.Semaphore(concurrency)
        probe_task = progress.add_task("ffprobe testing", total=len(alive_streams), working=0, dead=0, timeout=0)
        counts = {"working": 0, "dead": 0, "timeout": 0}

        async def probe_one(stream: ParsedStream) -> StreamTestResult:
            async with probe_sem:
                result = await test_stream(stream.url, timeout=timeout)
                result.channel_name = stream.channel_name
                result.group = stream.group
                result.sources = stream.source_id.split(",") if stream.source_id else []
                counts[result.status.value] += 1
                progress.update(probe_task, advance=1, **counts)
                if on_result:
                    on_result(result)
                return result

        probe_results = await asyncio.gather(*[probe_one(s) for s in alive_streams])
        results.extend(probe_results)

    return [r for r in results if r is not None]
