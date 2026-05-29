# USA TV Next

Stremio addon serving free IPTV streams for US television channels. Ships in **two modes**:

- **Static** — JSON files (`catalog/`, `meta/`, `stream/`, `manifest.json`) served from GitHub raw URLs. No server. Streams only.
- **Combined server** (`server/`) — a Node/Docker addon serving `catalog` + EPG-enriched `meta` + `stream` from one always-on instance. Merges the former standalone `stremio-usatv-epg` guide addon into this repo, so a single addon owns the whole `ustv` id space (no cross-addon meta collision) and adds live Now Playing / Up Next / day schedule.

## Quick Reference

```bash
uv run python -m harvester harvest          # Scrape all 167 sources for M3U streams
uv run python -m harvester test             # Test streams with ffprobe (DNS pre-filter + ffprobe)
uv run python -m harvester test --limit 100 # Test first N streams only
uv run python -m harvester report           # Generate report from test results
uv run python -m harvester run              # Harvest + test + report in sequence
uv run python -m harvester.inject           # Inject working streams into catalog channels
uv run python -m harvester clean            # Purge blocklisted providers (Pluto) + reorder tvpass-first
uv run python -m harvester tvpass-discover  # Generate tvpass candidates for channels missing them
uv run python -m harvester tvpass-discover --test  # Probe candidates with ffprobe + inject working ones
```

## Provider Policy

Defined in `harvester/config.py` and mirrored in the server (`server/src/config.js`):

- **Blocklist** (`BLOCKLIST_URL_SUBSTRINGS` / `STREAM_BLOCKLIST_HOSTS`, default `pluto.tv`): streams from these hosts are never injected, are purged by `clean`, and are filtered out at runtime by the server's stream handler. Pluto TV is no longer accessible.
- **Priority** (`PROVIDER_PRIORITY` / `STREAM_PRIORITY_HOSTS`, default `tvpass.org`): streams from these hosts sort to the top of each channel's list — tvpass.org is the most stable/accessible provider. Applied by `inject`, `clean`, and the server stream handler (stable sort).

`tvpass-discover` finds catalog channels with no tvpass.org stream, generates candidate `https://tvpass.org/live/<slug>/<quality>` URLs (CamelCase + East/West + kebab variants × sd/hd/fhd), and writes them to `data/tvpass_candidates.json`. With `--test` (host, needs ffprobe) it probes and injects the working ones.

Run stream testing on macmini for speed: `ssh ben@macmini`. Requires `eval "$(/opt/homebrew/bin/brew shellenv zsh)"` before `uv` or `ffprobe`.

## Structure

```
manifest.json              — Stremio addon manifest (id: community.usa-tv-next)
catalog/tv/all.json        — Master catalog: 169 channels with metadata + streams
catalog/tv/all/genre=*.json — Per-genre catalog slices (13 genres)
meta/tv/ustv-*.json        — Individual channel meta files (190 files)
stream/tv/ustv-*.json      — Per-channel stream files (460 files, many empty placeholders)
sources.yaml               — 167 source definitions (GitHub repos, direct URLs, websites, Telegram, paste)
harvester/                 — Python scraping + testing + injection pipeline
data/                      — Harvested streams, test results, state (gitignored)
public/                    — Logo and background images
server/                    — Combined Node/Docker addon (catalog + EPG meta + stream)
Dockerfile                 — Node 20 image bundling server/ + catalog/ + stream/
docker-compose.yml         — Local/host deployment (port 7001, 4 GB, cache volume)
.github/workflows/docker.yml — CI: build + push image to ghcr.io/<owner>/usa-tv-next
```

## Addon Data Flow

1. **Sources** (`sources.yaml`) define where to scrape M3U playlists
2. **Harvest** scrapes all sources, parses M3U, deduplicates by normalized URL
3. **Test** probes each stream URL: DNS resolve first (bulk dead domain elimination), then ffprobe
4. **Inject** matches working streams to existing catalog channels and writes them in
5. **Hosting**: GitHub raw URLs from `yowmamasita/usa-tv-next` repo serve the static JSON

## Channels

169 US TV channels across 13 genres. Channels are hardcoded — adding/removing requires editing catalog files.

| Genre | Count |
|-------|-------|
| Sports | 48 |
| Entertainment | 39 |
| Kids | 14 |
| News | 13 |
| Premium | 13 |
| Lifestyle | 13 |
| Documentaries | 11 |
| Music | 7 |
| Local | 6 |
| Latino | 5 |
| + Religious, Shopping, International |

Each channel is a Stremio meta object: `{id, name, genres, poster, posterShape, streams}`. Stream entries: `{url, behaviorHints: {notWebReady: true}, name: "FHD|HD|SD|Audio|[DEAD] HD", description: "HV:SOURCE_TAG"}`.

## Sources (`sources.yaml`)

167 sources across 5 types:

| Type | Count | Handler | Notes |
|------|-------|---------|-------|
| github | 72 | `sources/github.py` | Raw file fetch, tree API for globs, brute-force common M3U paths as fallback |
| direct | 56 | `sources/direct.py` | Direct M3U/M3U8 URLs |
| website | 30 | `sources/website.py` | HTML scraping for M3U links + Xtream Codes URLs |
| telegram | 8 | `sources/telegram.py` | Public Telegram channel scraping |
| paste | 1 | `sources/paste.py` | Paste site scraping |

GitHub source strategy: try literal paths first, then tree API (needs `GITHUB_TOKEN`, rate-limited at 60/hr unauthenticated), then brute-force ~55 common M3U filenames on both `main` and `master` branches.

## Harvester Architecture

```
harvester/
  cli.py        — Click CLI: harvest, test, report, run commands
  config.py     — Paths, timeouts (8s default), concurrency (harvest=10, test=50)
  models.py     — Pydantic models: SourceConfig, ParsedStream, StreamTestResult, CodecInfo
  parser.py     — M3U parser (EXTINF attrs, stream URLs, Xtream Codes detection)
  dedup.py      — URL normalization (strip tokens/sessions, normalize host/path) + dedup
  tester.py     — DNS pre-filter (200 concurrent resolves) + ffprobe testing (50 concurrent)
  inject.py     — Match working streams to catalog channels, update catalog/meta/genre files
  report.py     — Generate summary report from test results
  state.py      — Persist harvest/test state for resumable runs (atomic JSON writes)
  sources/
    base.py     — BaseSource ABC with fetch_url (retries, rate limit backoff)
    github.py   — GitHubSource: literal paths → tree API → brute-force common paths
    direct.py   — DirectSource: fetch + parse single M3U URL
    website.py  — WebsiteSource: scrape HTML for M3U links + Xtream URLs
    telegram.py — TelegramSource: scrape public Telegram channels
    paste.py    — PasteSource: scrape paste sites for M3U content
```

### Tester Pipeline

1. **DNS pre-filter**: Resolve unique hostnames (200 concurrent) → eliminate dead domains in bulk
2. **ffprobe**: Test surviving streams (50 concurrent, 8s timeout) → extract codecs, resolution, bitrate
3. Quality classification: FHD (≥1920w), HD (≥1280w), SD (≥720w), Audio (no video codec)

Optimal concurrency: 50 ffprobe processes. Higher (200+) overwhelms the system and kills accuracy.

### Inject Matching

`inject.py` matches harvested streams to catalog channels using:
- **Exact match**: normalized stream name == normalized channel name
- **Prefix match** (≥3 char names): stream name starts with channel name at word boundary, filtered by:
  - Non-US name suffixes (International, Italia, Indonesia, Finland, etc.)
  - Non-US URL patterns (qvcuk, tvkaista.net, etc.)
  - More-specific catalog channel dedup ("Fox" won't match "Fox News" if "Fox News" is its own channel)

### Dependencies

Python ≥3.10, managed with `uv`. Key deps: aiohttp, click, pydantic, pyyaml, rich. External: ffprobe (ffmpeg).

## Combined Server (`server/`)

Node addon (`community.usa-tv-next` v3) that owns `catalog` + `meta` + `stream` for `ustv`. Reuses the harvested static JSON as its data and overlays EPG.

```
server/src/
  log.js          — leveled logger (LOG_LEVEL; ISO timestamps; timed() helper)
  config.js       — all env config, logged at boot
  data.js         — HYBRID data layer: roster + per-channel streams
  epg.js          — XMLTV fetch/parse/now-playing + disk-cache resilience
  channelMap.js   — fuzzy match roster->EPG (130+ overrides); roster from data.js
  manifest.js     — combined manifest (catalog id "all"; resources catalog+meta+stream)
  catalogHandler.js / metaHandler.js — EPG-enriched catalog + meta
  streamHandler.js — serves streams via data.getStreams()
  addon.js / server.js — builder wiring + startup + refresh intervals + serveHTTP
```

**Hybrid data layer (`data.js`).** Roster read precedence is **live GitHub fetch → emergency cache file → bundled local file**, so the addon survives loss of GitHub access. A `DATA_REFRESH_HOURS` interval re-fetches the roster and rewrites the emergency cache (on the `usatv-cache` volume). Per-channel stream resolution: inline roster `streams` → in-memory cache → bundled local `stream/tv/{id}.json` → lazy GitHub fetch. EPG (`epg.pw`) refreshes on `EPG_REFRESH_HOURS`; the matched-channel subset is persisted to disk for cold-start resilience.

**Key env vars:** `PORT`/`HOST`, `EPG_URL`, `GITHUB_RAW_BASE`, `DATA_REFRESH_HOURS`, `EPG_REFRESH_HOURS`, `TZ`, `LOG_LEVEL` (set `debug` for per-request routing/cache/fetch logs), `NODE_OPTIONS=--max-old-space-size=3072` (needs ~4 GB for the ~188 MB EPG parse).

> Data note: `catalog/tv/all.json` carries empty inline `streams` by design (Stremio fetches streams lazily per id). The server therefore resolves streams from `stream/tv/{id}.json`. Once `inject.py` populates inline `streams` in `all.json`, the roster fetch alone refreshes streams without a redeploy.

## Deployment

**Static mode:** push to GitHub; Stremio clients fetch catalog/meta/stream JSON via raw.githubusercontent.com URLs. No build step.

**Server mode:** push to `main` (touching `server/**`, `catalog/**`, `stream/**`, or `Dockerfile`) triggers `.github/workflows/docker.yml`, which builds and pushes `ghcr.io/<owner>/usa-tv-next:latest` (+ `sha-` and semver tags). Run it with `docker compose up -d --build`, or pull the published image. Install only this addon in Stremio (uninstall the static `usa-tv-next` and `stremio-usatv-epg` to avoid the shared-`ustv` meta collision). HTTPS required for Stremio Web (reverse proxy / Cloudflare Tunnel).
