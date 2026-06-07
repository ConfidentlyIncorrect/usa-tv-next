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
uv run python -m harvester iptvorg-enrich [--apply]  # Add reliable NEW iptv-org US streams to EXISTING channels (ffprobe-validated, deduped by region+quality)
uv run python -m harvester iptvorg-candidates        # Categorize iptv-org US channels we lack, by the curation rules (report only)
uv run python -m harvester famelack-enrich  # Add ffprobe-validated famelack streams to EXISTING channels (no new channels)
uv run python -m harvester famelack-import --keyword telemundo --genre Latino --logo telemundo-us  # Import NEW channels (curated, deduped, validated)
```

`famelack-import` adds NEW catalog channels from famelack filtered by name keyword: drops geo-blocked + duplicates (accent-folded normalized name, vs catalog and intra-batch), ffprobe-validates streams (imports only channels with a working stream), generates a `ustv-<uuid>` id, writes catalog + genre slice + meta + stream files, and assigns art (reuses a repo logo via `--logo <slug>`, else iptv-org). This is the curated/test path for growing beyond the original 169 (e.g. the Telemundo test added Acción / Corpus Christi / Noticias Ahora / Romance, 169 -> 173).

## Logos / banners / subtitles

- **Logos/banners**: the repo ships `public/logos/usa/<slug>.png` (transparent logo) + `public/posters/usa/<slug>.png` (2:3 portrait, logo centered on a solid neutral background) for **every** channel, and the catalog/meta/genre `poster`+`logo` URLs are **self-hosted** on this repo's raw URLs (`raw.githubusercontent.com/ConfidentlyIncorrect/usa-tv-next/main/public/...`). Nuvio renders catalog cards from `poster` (Crop-scaled) and overlays the transparent `logo` only on the focused card, so the card art must be a clean filled poster — a bare transparent/wide logo (what famelack ships) Crop-fills the card and looks flashy/mis-sized.
  - **`harvester/banners.py` (CLI `banners`)** normalizes this. For each famelack channel it sources the best logo — **curated `KNOWN_LOGOS` override → iptv-org (trying the name with our `US`/`East`/… suffix stripped) → the channel's own art** — rejects famelack's generic placeholder graphics (an image shared by ≥2 channels with ≥2 distinct first-words; brand-shared logos like Vevo/FilmRise keep their one shared word), composites the logo (centered, padded) onto the originals' `#333` background (a light plate for predominantly-dark logos), and writes `posters/usa/<slug>.png` + `logos/usa/<slug>.png`. Channels with no usable logo get a clean **text wordmark** poster (the channel name in centered typography) — never a flashy placeholder. It also repoints the 157 originals' art off the old upstream owner onto our repo. Needs Pillow (`uv add pillow`).
  - `harvester/logos.py` (CLI `logos`) is the older iptv-org logo fetcher (name → best logo by in_use/format/size), used to fill missing logos for NEW channel imports.
- **Subtitles**: no per-stream subtitle field is injected. Entries set `behaviorHints.notWebReady=true` so the native HLS player surfaces in-manifest **WebVTT** subtitle renditions automatically (the stream proxy proxifies `#EXT-X-MEDIA:TYPE=SUBTITLES` URIs, so proxying does not drop them). Feeds that carry only **CEA-608/708** in-band captions (re-streams like tvpass = bare media playlist) expose no WebVTT track; the NuvioTV `custom` fork's player surfaces those as a selectable "Closed Captions" track (`DefaultHlsExtractorFactory(exposeCea608WhenMissingDeclarations=true)`). Quality-first ordering also helps here by defaulting to the higher-quality feed, which is usually the one with a real WebVTT subtitle rendition.
- **No duplicate channels**: all injectors (`inject`, `tvpass-discover`, `logos`, famelack fill) only enrich EXISTING catalog channels matched by id/name and dedup streams by URL; none create catalog entries. Any future bulk import of new famelack channels must dedup by normalized name against the existing roster.

## Provider Policy

Defined in `harvester/config.py` and mirrored in the server (`server/src/config.js`):

- **Blocklist** (`BLOCKLIST_URL_SUBSTRINGS` / `STREAM_BLOCKLIST_HOSTS`, default `pluto.tv`): streams from these hosts are never injected, are purged by `clean`, and are filtered out at runtime by the server's stream handler. Pluto TV is no longer accessible.
- **Priority** (`PROVIDER_PRIORITY` / `STREAM_PRIORITY_HOSTS`, default `tvpass.org`): the harvester (`inject`/`clean`) writes tvpass-first into the data files, but the **server now orders streams QUALITY-FIRST** (`STREAM_SORT=quality`, default): FHD>HD>SD>Audio, with tvpass as a same-quality tiebreaker and the harvester's order as the final stable tiebreaker. This makes the best-quality feed (usually the one carrying WebVTT subtitles) the default/auto-play stream — audited 55/65 multi-quality channels were defaulting to non-best quality under tvpass-first → now 0. `STREAM_SORT=data` reverts to the raw harvester order.

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
catalog/tv/all.json        — Master catalog: 293 channels with metadata + streams
catalog/tv/all/genre=*.json — Per-genre catalog slices (10 genres)
meta/tv/ustv-*.json        — Individual channel meta files (293, 1:1 with catalog)
stream/tv/ustv-*.json      — Per-channel stream files (293, 1:1 with catalog; no empty placeholders)
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

293 US TV channels across 10 genres. Channels are hardcoded — adding/removing requires editing catalog files. Meta and stream files are kept 1:1 with the catalog (no orphan/placeholder files).

| Genre | Count |
|-------|-------|
| Entertainment | 81 |
| Sports | 51 |
| Lifestyle | 37 |
| News | 26 |
| Documentaries | 23 |
| Kids | 21 |
| Latino | 18 |
| Music | 17 |
| Premium | 13 |
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
  epg.js          — EPG engine: Schedules Direct (primary, if configured) w/ XMLTV fallback;
                    XMLTV path is a STREAMING parse (no DOM) + now-playing + disk-cache
  sd.js           — Schedules Direct JSON provider (token->auto-lineup->stations->schedules->programs)
  channelMap.js   — fuzzy match roster->EPG (130+ overrides); roster from data.js
  manifest.js     — combined manifest (catalog id "all"; resources catalog+meta+stream)
  catalogHandler.js / metaHandler.js — EPG-enriched catalog + meta
  streamHandler.js — serves streams via data.getStreams() (+ adds DaddyLive fallback streams)
  proxy.js        — HLS-rewriting stream proxy (/proxy) for fragile/header-gated feeds
  dlhd.js         — DaddyLive live resolver + re-serving HLS endpoints (/dlhd) — see below
  dlhdChannels.js — roster id -> dlhd numeric id map (71 DARK + 59 EXTRA, US-feed pinned)
  addon.js / server.js — builder wiring + startup + refresh intervals + serveHTTP
```

**Hybrid data layer (`data.js`).** Roster read precedence is **live GitHub fetch → emergency cache file → bundled local file**, so the addon survives loss of GitHub access. A `DATA_REFRESH_HOURS` interval re-fetches the roster and rewrites the emergency cache (on the `usatv-cache` volume). Per-channel stream resolution: inline roster `streams` → in-memory cache → bundled local `stream/tv/{id}.json` → lazy GitHub fetch. EPG refreshes on `EPG_REFRESH_HOURS`; the matched-channel subset is persisted to disk for cold-start resilience.

**EPG source (`epg.js` + `sd.js`) — MERGED 3-TIER.** Every refresh fetches all configured sources and merges them by priority: **(1) Schedules Direct** (accurate, feed/timezone-correct), **(2) epg.pw** (`EPG_URL`), **(3) epgshare01 + i.mjh.nz** (`EPGSHARE_URLS` default = epgshare01 US2 + i.mjh.nz Samsung TV Plus / Plex / Pluto / Roku — the FAST/streaming long tail neither of the above carries: AsianCrush, RetroCrush, Dark Matter, XITE, FilmRise, Comet, Buzzr, Vevo, …).

> **Recent EPG correctness fixes (all live):** (a) `parseChannels` scans the WHOLE document — the i.mjh.nz feeds INTERLEAVE `<channel>` with their `<programme>`s rather than listing channels first, and the old "stop at first `<programme>`" optimization silently dropped ~all of them (this single fix took pw+es matches 202→265). (b) SD `_dateRange` fetches **yesterday too** (UTC days don't align with a UTC-negative local day). (c) SD returns ONE response element per (station, DATE); `loadSchedules` now **accumulates** across dates instead of overwriting — the prior overwrite left only the last date (a single UTC day starting at 00:00 UTC = 6 PM Denver), which was the "guide stuck at 6 PM / no now-playing" bug. (d) `getNowPlaying` takes the GREATEST start ≤ now (validated via stop→next→+6h cap), not the first match, so a duration-less entry can't surface a stale programme. (e) `getGuideWindow()` emits a compact absolute-time window as `stream.epgSchedule` (+ `meta.epgSchedule` with synopsis) so the NuvioTV fork recomputes now/next on its own clock — live and cache-proof; `stream.epg` (now/next string) remains the fallback. channelMap matches the roster in that order, so each higher tier wins and lower tiers only **fill gaps**. Programmes from every source share one store via an `sd:`/`pw:`/`es:` id-prefix; `getEPGChannelId` returns the prefixed id and `getNowPlaying`/etc. dispatch on it. Any source can fail independently; with no SD creds it's epg.pw+epgshare01; the streaming XMLTV parser keeps memory low even with several feeds. `channelMap.SD_OVERRIDES` (exact SD name pins, incl. Denver broadcast affiliates) corrects SD mismatches; `MANUAL_OVERRIDES` tunes the XMLTV passes. `GET /debug/epg?full=1` reports matched (with `source`: sd/pw/es), unmatched, and the full EPG name list. SD lineup setup is automatic from `SD_ZIP` (see below). The disk cache, `EPG_OFFSET_HOURS`, and lookups work identically across sources. **SD setup (no manual lineup curation):** create an account at schedulesdirect.org (~$35/yr), then set `SD_USERNAME`/`SD_PASSWORD` + `SD_ZIP`. On startup `sd.js` **auto-manages the account's lineups** via the SD JSON API: it adds the most comprehensive lineup for the ZIP (`/headends` -> preview candidates -> `PUT` the one with the MOST channels; prefers DirecTV/Dish satellite), and **removes the tiny AFN military lineup** (`DELETE /lineups/{id}`) once a real lineup is present (SD returns AFN for civilian ZIPs; ~14 channels, useless here). It picks by actual channel count so it never settles for AFN; it's idempotent (no API changes once a good lineup is in and AFN is gone), never strips the account to zero lineups, and respects SD's daily lineup-change limit (DELETE retries on a later refresh if the limit is hit). AFN stations are also skipped during collection while present. `SD_TRANSPORT` overrides the Satellite preference; leaving `SD_ZIP` unset reverts to adding lineups by hand on the SD site. The XMLTV path is a low-memory STREAMING parse (no DOM — fixes the prior ~188 MB OOM).

**Key env vars:** `PORT`/`HOST`, `EPG_URL` (epg.pw tier-2 XMLTV), `EPGSHARE_URLS` (epgshare01 tier-3 feeds, comma-separated; `''` disables), `SD_USERNAME`/`SD_PASSWORD` (enable Schedules Direct), `SD_ZIP` (auto-add a lineup for that postal code), `SD_TRANSPORT` (Satellite/Cable/Antenna/IPTV; default prefer Satellite), `SD_LINEUP` (substring filter to one lineup), `SD_DAYS` (schedule days, default 2), `STREAM_SORT` (`quality` default / `data`), `RESPONSE_CACHE_SECS` (default 300), `PROXY_PUBLIC_URL`/`PROXY_DISABLE`/`PROXY_FORCE_HOSTS`, `GITHUB_RAW_BASE`, `DATA_REFRESH_HOURS`, `EPG_REFRESH_HOURS`, `TZ`, `LOG_LEVEL` (set `debug` for per-request routing/cache/fetch logs), `NODE_OPTIONS=--max-old-space-size=3072`. Diagnostics: `GET /debug/epg?full=1` and `GET /debug/schedule?ch=<name>`.

> Data note: `catalog/tv/all.json` carries empty inline `streams` by design (Stremio fetches streams lazily per id). The server therefore resolves streams from `stream/tv/{id}.json`. Once `inject.py` populates inline `streams` in `all.json`, the roster fetch alone refreshes streams without a redeploy.

### DaddyLive resolver (`dlhd.js` + `dlhdChannels.js`) — restores the tvpass-dark tier

When tvpass.org died, **71 premium/cable/sports channels lost their only stream** (ESPN family, RSNs, A&E/AMC/TBS/TNT/USA, CNBC/MSNBC/Fox Business, the HBO/Showtime/Starz/Cinemax multiplexes, Disney/Nick kids, Telemundo, …). DaddyLive (`dlhd.pk`) carries that exact tier as stable 24/7 channels, so the server resolves it **live at request time** and re-serves it as clean HLS through the existing proxy.

**The chain (verified end-to-end).** `dlhd.pk/watch.php?id=N` → iframe `stream/stream-N.php` (obfuscated player) → iframe `https://<rotating-embed-host>/premiumtv/daddy3.php?id=N`; the embed page **base64-encodes (`atob`) the final media URL**, e.g. `https://<cdn>/premiumN/index.m3u8?md5v1=..&md5v2=..&expires=<unixSec>`. That master points at one media playlist (`tracks-v1a1/mono.m3u8?md5=..&expires=..`) whose `.ts` segments are disguised as `.pdf`/`.js` on **another** rotating host.

**Three facts drive the design:** (1) **no referer/origin lock anywhere** — auth is entirely the in-URL `md5`/`expires` token, so the plain `/proxy` plays them and **NuvioTV needs zero changes** (it just gets a clean HLS URL on our host, exactly like tvpass/XUMO); (2) the token **expires ~58 min** after it's minted, fresh per resolve, so a URL can't be statically injected — it must be resolved live and **re-resolved before expiry**; (3) the embed host + segment host **rotate** periodically, so we discover the embed host from `stream-N.php` on every resolve and rotation self-heals.

**Two endpoints** (routed at `/dlhd/` in `server.js`, before the SDK router):
- `GET /dlhd/<id>/master.m3u8` → a **synthesized** master (re-emits the upstream `#EXT-X-STREAM-INF` for codec/res metadata) whose only variant points at our own media endpoint — so the player polls **us**, never the expiring CDN URL.
- `GET /dlhd/<id>/media.m3u8` → fetches the **current** (cached, auto-refreshed-before-expiry) media playlist and rewrites every segment through `/proxy` (via `proxy.rewriteManifest`). Because this endpoint re-resolves under the hood, **token expiry is invisible to the player and sessions run indefinitely**.

Resolution is **cached per dlhd id + single-flighted** (concurrent callers share one in-flight resolve; re-resolve only fires within `DLHD_TOKEN_MARGIN_MS` of expiry), so dlhd.pk is hit at most ~once/hour/channel. `streamHandler` adds the dlhd master URL as a stream entry (`"{Channel} (HD)"` / desc `DaddyLive`) for any mapped channel when the proxy is active; `normalizeStream` never re-wraps our own `/dlhd` URL. The map lives in `dlhdChannels.js`: **DARK** (71 — the tvpass-dark channels, always on) + **EXTRA** (59 — channels that still have a free feed but also exist on dlhd; **on by default** so every match gets a DaddyLive HD alternate — set `DLHD_INCLUDE_EXTRA=0` for DARK-only). 130 channels mapped total. dlhd ids are the `N` in `watch.php?id=N`, **pinned to the US feed** (e.g. ESPN USA=44), never a foreign variant. Regenerate the map with `data/dlhd_match.js` + `data/dlhd_gen_module.js` (both gitignored helpers; the matcher detects dark channels = zero **servable** streams — i.e. not blocklisted AND not `[DEAD]`-tagged — and name-matches them against a scraped `data/dlhd_id_name.tsv`).

> **Dead-feed handling.** `streamHandler` drops any stream a prior `consolidate` run tagged dead (`name` prefixed `[DEAD]`) alongside the host blocklist — so a channel whose only static feed is dead (e.g. **Telemundo**, whose lone `nbcu-telemundoflorida-firetv.amagi.tv` feed is a frozen "black then exit" loop) is treated as dark, falls back to DaddyLive, and never offers the dead URL. The matcher applies the same rule, so such channels land in DARK rather than being miscounted as live.

**Env vars:** `DLHD_ENABLE` (default on), `DLHD_INCLUDE_EXTRA` (default **on**), `DLHD_BASE` (default `https://dlhd.pk`), `DLHD_EMBED_HOST` (optional fallback embed host if `stream-N.php` discovery fails — follow rotations without a code change), `DLHD_TOKEN_MARGIN_MS` (default 120000), `DLHD_RESOLVE_TIMEOUT_MS` (default 15000), `DLHD_OUTBOUND_PROXY` (split-tunnel — see below). **Requires the proxy active** (PROXY_PUBLIC_URL or an auto-learned public base). Diagnostics: `GET /debug/dlhd?id=<N>` runs the live chain and reports master/media/cdnHost/expires/ttl; `/health` shows `dlhd.mappedChannels` + `outboundProxy`.

> **Split-tunnel egress (`DLHD_OUTBOUND_PROXY` + `outbound.js`).** DaddyLive's premium **embed + CDN** origins (raw nginx VPS IPs, IPv4-only, not Cloudflare) **drop datacenter/VPS egress IPs** — the main `dlhd.pk` site loads but the embed/CDN time out (`cannot reach <host>: UND_ERR_CONNECT_TIMEOUT`). They work from residential IPs. Routing the *whole* addon through a VPN is undesirable (it'd tunnel EPG/GitHub/iptv-org/Tubi and can break the public Funnel inbound), so we **split-tunnel only DaddyLive**: set `DLHD_OUTBOUND_PROXY` to an HTTP(S) proxy on a residential/VPN exit (e.g. a `gluetun` sidecar's `http://gluetun:8888`) and `outbound.js` hands an undici `ProxyAgent` as the `dispatcher` to **every** dlhd fetch — the resolver chain, the media-playlist fetch, AND the CDN segments. Segments reach the proxy because `dlhd.js` rewrites the media playlist via `proxy.rewriteManifest(text, url, '?o=dlhd')`, and `proxy.handle` routes any `?o=dlhd`-tagged upstream through the same dispatcher; all other proxied feeds (tvpass/XUMO/…) stay direct. Needs the `undici` dep (added) — Node bundles undici for `fetch` but `ProxyAgent` needs the package; if it's missing, `outbound.js` logs once and falls back to direct. `docker-compose.yml` has a commented gluetun sidecar template (WireGuard/OpenVPN). The "cannot reach ...: ENOTFOUND/EAI_AGAIN" variant instead means a filtering DNS (Pi-hole/NextDNS) is blocking the domains; "ECONNREFUSED"/timeout = the IP block this knob fixes.

**4 dark channels can't be restored** (genuinely absent from dlhd AND iptv-org): BET Her, Hallmark Family, MeTV Toons, MTV2. (TV Land was a normalizer miss — "TV Land"→"land" vs dlhd's spaceless "TVLAND"→"tvland" — now pinned manually to id 342. MotorTrend isn't on dlhd but its iptv-org/Tubi FAST feed is live — injected into its stream file, force-proxied as a Yospace SSAI host.) **Maintenance:** if the embed scheme changes (a few times/year), update the `atob`/embed-URL extraction in `dlhd.js` (`_extractEmbedUrl` / `_extractMasterUrl`); the well-trodden open-source DaddyLive resolvers track the current scheme. Caveat: dlhd is a piracy re-aggregator — high coverage, lower long-term stability than a clean origin.

## Deployment

**Static mode:** push to GitHub; Stremio clients fetch catalog/meta/stream JSON via raw.githubusercontent.com URLs. No build step.

**Server mode:** push to `main` (touching `server/**`, `catalog/**`, `stream/**`, or `Dockerfile`) triggers `.github/workflows/docker.yml`, which builds and pushes `ghcr.io/<owner>/usa-tv-next:latest` (+ `sha-` and semver tags). Run it with `docker compose up -d --build`, or pull the published image. Install only this addon in Stremio (uninstall the static `usa-tv-next` and `stremio-usatv-epg` to avoid the shared-`ustv` meta collision). HTTPS required for Stremio Web (reverse proxy / Cloudflare Tunnel).
