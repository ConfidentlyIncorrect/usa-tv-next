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
uv run python -m harvester consolidate      # Re-probe all streams: fix formats, drop dead, relabel
uv run python -m harvester relabel           # Reformat stream display names (no re-probe; dynamic)
uv run python -m harvester regionalize       # Order each channel's feeds by local relevance + dedup
uv run python -m harvester clean            # Purge blocklisted providers (Pluto) + reorder tvpass-first
uv run python -m harvester tvpass-discover --probe # Scrape tvpass directory, read real slugs, inject live links
uv run python -m harvester logos            # Grab logos from iptv-org for channels missing a local logo file
uv run python -m harvester banners          # Normalize art -> clean 2:3 posters (logo on neutral bg / text wordmark) + self-host URLs
uv run python -m harvester famelack-enrich  # Add ffprobe-validated famelack streams to EXISTING channels (no new channels)
uv run python -m harvester famelack-import --keyword telemundo --genre Latino --logo telemundo-us  # Import NEW channels (curated, deduped, validated)
```

`famelack-import` adds NEW catalog channels from famelack filtered by name keyword: drops geo-blocked + duplicates (accent-folded normalized name, vs catalog and intra-batch), ffprobe-validates streams (imports only channels with a working stream), generates a `ustv-<uuid>` id, writes catalog + genre slice + meta + stream files, and assigns art (reuses a repo logo via `--logo <slug>`, else iptv-org). This is the curated/test path for growing beyond the original 169 (e.g. the Telemundo test added Acción / Corpus Christi / Noticias Ahora / Romance, 169 -> 173).

## Logos / banners / subtitles

- **Logos/banners**: the repo ships `public/logos/usa/<slug>.png` (transparent logo) + `public/posters/usa/<slug>.png` (2:3 portrait, logo centered on a solid neutral background) for **every** channel, and the catalog/meta/genre `poster`+`logo` URLs are **self-hosted** on this repo's raw URLs (`raw.githubusercontent.com/ConfidentlyIncorrect/usa-tv-next/main/public/...`). Nuvio renders catalog cards from `poster` (Crop-scaled) and overlays the transparent `logo` only on the focused card, so the card art must be a clean filled poster — a bare transparent/wide logo (what famelack ships) Crop-fills the card and looks flashy/mis-sized.
  - **`harvester/banners.py` (CLI `banners`)** normalizes this. For each famelack channel it sources the best logo — **curated `KNOWN_LOGOS` override → iptv-org (trying the name with our `US`/`East`/… suffix stripped) → the channel's own art** — rejects famelack's generic placeholder graphics (an image shared by ≥2 channels with ≥2 distinct first-words; brand-shared logos like Vevo/FilmRise keep their one shared word), composites the logo (centered, padded) onto the originals' `#333` background (a light plate for predominantly-dark logos), and writes `posters/usa/<slug>.png` + `logos/usa/<slug>.png`. Channels with no usable logo get a clean **text wordmark** poster (the channel name in centered typography) — never a flashy placeholder. It also repoints the 157 originals' art off the old upstream owner onto our repo. Needs Pillow (`uv add pillow`).
  - `harvester/logos.py` (CLI `logos`) is the older iptv-org logo fetcher (name → best logo by in_use/format/size), used to fill missing logos for NEW channel imports.
- **Subtitles**: famelack and tvpass both serve HLS (`.m3u8`) with no separate subtitle field, so there is nothing to inject per stream. Every injected entry sets `behaviorHints.notWebReady=true`, so Stremio/Nuvio use a native HLS player that surfaces the stream's embedded WebVTT subtitle tracks automatically — identical behavior to tvpass.
- **No duplicate channels**: all injectors (`inject`, `tvpass-discover`, `logos`, famelack fill) only enrich EXISTING catalog channels matched by id/name and dedup streams by URL; none create catalog entries. Any future bulk import of new famelack channels must dedup by normalized name against the existing roster.

## Provider Policy

Defined in `harvester/config.py` and mirrored in the server (`server/src/config.js`):

- **Blocklist** (`BLOCKLIST_URL_SUBSTRINGS` / `STREAM_BLOCKLIST_HOSTS`, default `pluto.tv`): streams from these hosts are never injected, are purged by `clean`, and are filtered out at runtime by the server's stream handler. Pluto TV is no longer accessible.
- **Priority** (`PROVIDER_PRIORITY` / `STREAM_PRIORITY_HOSTS`, default `tvpass.org`): streams from these hosts sort to the top of each channel's list — tvpass.org is the most stable/accessible provider. Applied by `inject`, `clean`, and the server stream handler (stable sort).

`tvpass-discover` finds catalog channels with no tvpass.org stream. Three modes:
- **`--probe` (recommended)** — scrapes the tvpass homepage directory of `/channel/<slug>` links, matches each missing channel by token overlap, fetches its channel page, and reads the *real* stream slug from `<div id="stream_name" name="...">`, then verifies `/live/<slug>/<q>` is `200 + application/vnd.apple.mpegurl` before injecting. tvpass throttles bursts (hangs after ~2 rapid requests), so requests are spaced by `--delay` (default 5s). No ffprobe needed. Stream slugs are NOT derivable from the channel name (`Telemundo`→`TelemundoEast` is wrong) — they must be read off the page.
- **`--test`** — ffprobe-validates generated candidate slugs (deeper, slower).
- default (no flag) — writes candidate URLs to `data/tvpass_candidates.json` for review.

Note: many RSN/sports feeds (FanDuel etc.) return 404 when no live event is on, so re-run `--probe` periodically to catch channels while they're broadcasting.

The slug generator (`harvester/tvpass.py`) is validated against `harvester/tvpass_known.json` — 131 verified `channel name → slug` mappings extracted from the tvpass links already in the addon. Those overrides reproduce **100%** of known-working slugs; the heuristic fallback (case forms, suffix add/drop, `+`→Plus, `Jr`→Junior, FanDuel full-name, East/West/HD feeds) independently reproduces ~79% of them, and is what covers channels never seen before. Regenerate the map after adding tvpass links: it's just the current name→slug pairs.

Run stream testing on macmini for speed: `ssh ben@macmini`. Requires `eval "$(/opt/homebrew/bin/brew shellenv zsh)"` before `uv` or `ffprobe`.

## Structure

```
manifest.json              — Stremio addon manifest (id: community.usa-tv-next)
catalog/tv/all.json        — Master catalog: 247 channels with metadata + streams
catalog/tv/all/genre=*.json — Per-genre catalog slices (10 genres)
meta/tv/ustv-*.json        — Individual channel meta files (247, 1:1 with catalog)
stream/tv/ustv-*.json      — Per-channel stream files (247, 1:1 with catalog; no empty placeholders)
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

247 US TV channels across 10 genres. Channels are hardcoded — adding/removing requires editing catalog files. Meta and stream files are kept 1:1 with the catalog (no orphan/placeholder files).

| Genre | Count |
|-------|-------|
| Entertainment | 66 |
| Sports | 49 |
| Lifestyle | 31 |
| Documentaries | 20 |
| News | 18 |
| Music | 18 |
| Kids | 17 |
| Premium | 13 |
| Latino | 9 |
| Local | 6 |

Each channel is a Stremio meta object: `{id, name, genres, poster, posterShape, streams}`. Stream entries: `{url, behaviorHints: {notWebReady, proxyHeaders}, name: "{Channel}[ - {Region}] ({FHD|HD|SD|Audio})", description: "{Provider}"}` — the channel name is always in the big label, the region is added for feed-variants, and the provider/supplier goes in the small description (see `harvester/consolidate.py:build_display`).

## Sources (`sources.yaml`)

167 sources across 5 types:

| Type | Count | Handler | Notes |
|------|-------|---------|-------|
| github | 72 | `sources/github.py` | Raw file fetch, tree API for globs, brute-force common M3U paths as fallback |
| direct | 56 | `sources/direct.py` | Direct M3U/M3U8 URLs |
| website | 30 | `sources/website.py` | HTML scraping for M3U links + Xtream Codes URLs |
| telegram | 8 | `sources/telegram.py` | Public Telegram channel scraping |
| paste | 1 | `sources/paste.py` | Paste site scraping |
| famelack | 1 | `sources/famelack.py` | famelack.com's full dataset, gzipped JSON on GitHub (famelack/famelack-data); 1361 US channels with direct stream_urls + languages (incl. non-English). Drops isGeoBlocked unless `strategy: include_geoblocked` |

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

**HLS validity (`_hls_manifest_probe`)** follows master→variant and only passes a feed whose MEDIA playlist actually loads with segments — so a master that 200s but whose variants 404 (expired tokens) is correctly DEAD, not "buffers forever." It also flags **frozen** feeds: a media playlist carrying `#EXT-X-ENDLIST` in this all-LIVE catalog means a decommissioned/stuck origin (e.g. the dead `nbcu-telemundo*-firetv.amagi.tv` FAST feeds serve a frozen ~10-segment loop with ENDLIST + a 403 first segment → "second of black, then exit"). The segments still decode, so ffprobe wrongly passes them; the ENDLIST marker is the reliable tell and forces DEAD.

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
