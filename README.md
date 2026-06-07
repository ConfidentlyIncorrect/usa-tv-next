# USA TV Next

293 live US TV channels across 10 genres: Entertainment (81), Sports (51), Lifestyle (37), News (26), Documentaries (23), Kids (21), Latino (18), Music (17), Premium (13), Local (6).

This repo ships the addon in **two modes**:

1. **Static** (`manifest.json` + `catalog/` + `meta/` + `stream/`) — hosted entirely on GitHub raw URLs, no server. Streams only, no live guide.
2. **Combined Docker server** (`server/`) — a single Node addon that serves catalog **+ EPG-enriched meta + streams** from one always-on instance. This is the merged successor to the separate `stremio-usatv-epg` guide addon: one install, no meta-resource collision, and a **merged multi-source EPG** (Schedules Direct → epg.pw → epgshare01/i.mjh.nz) driving live Now Playing / Up Next / day schedule. **Recommended.**

> **Companion app:** the [NuvioTV `custom` fork](https://github.com/ConfidentlyIncorrect/NuvioTV/tree/custom) adds a focus-reactive, **live-ticking** EPG panel on the stream-selection screen and a live guide on the channel detail screen, fed by the non-standard `epgSchedule` field this server emits. Standard Stremio clients ignore that field and still render the `description`/`epg` text guide.

> Install only ONE of these in a client. If you install both the static addon and the Docker addon they share the `ustv` id space and collide on the `meta` resource.

## Install (static)

Streams-only addon served straight from GitHub raw — no server, no live guide. Reflects the current **293-channel** catalog with Pluto removed. For live EPG (Now Playing / schedules) and quality-first stream ordering, use the Combined Docker server below instead.

Stremio app (desktop / Android) — paste into the addon search bar, or open:

```
stremio://raw.githubusercontent.com/ConfidentlyIncorrect/usa-tv-next/main/manifest.json
```

[Install via Stremio Web](https://web.stremio.com/#/addons?addon=https%3A%2F%2Fraw.githubusercontent.com%2FConfidentlyIncorrect%2Fusa-tv-next%2Fmain%2Fmanifest.json)

> Manifest id `community.usa-tv-next` (v3.0.0). The catalog/meta/stream JSON is fetched relative to this URL, so it always serves the latest data on `main`. (The repo must stay public for raw URLs to resolve.)

## Combined Docker server (`server/`)

A single addon (`community.usa-tv-next`) providing `catalog` + `meta` + `stream` for the `ustv` id space, with an integrated EPG. Works in Stremio and Nuvio (the EPG renders in the channel detail view, same place as a movie synopsis).

```bash
docker compose up -d --build
curl -s http://localhost:7001/manifest.json     # should list catalog, meta, stream
```

Or pull the prebuilt image published by CI:

```bash
docker run -d -p 7001:7001 --memory=4g ghcr.io/confidentlyincorrect/usa-tv-next:latest
```

**Hybrid data layer:** bundled local JSON (in the image) is the offline baseline; an interval (`DATA_REFRESH_HOURS`) fetches the latest roster from GitHub and writes an emergency cache to the `usatv-cache` volume. Read precedence is **live fetch → emergency cache → bundled local**, so the addon keeps working if GitHub access is lost. The EPG is fetched on `EPG_REFRESH_HOURS` and its matched subset is cached to disk for cold-start resilience.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` / `HOST` | `7001` / `0.0.0.0` | HTTP bind |
| `EPG_URL` | epg.pw US XMLTV | Tier-2 EPG (epg.pw, gz or plain) |
| `EPGSHARE_URLS` | epgshare01 US2 + i.mjh.nz Samsung/Plex/Pluto/Roku | Tier-3 FAST/streaming gap-fill feeds (comma-separated; `''` disables) |
| `SD_USERNAME` / `SD_PASSWORD` | _(unset)_ | Schedules Direct creds → enables it as the PRIMARY EPG tier |
| `SD_ZIP` | _(unset)_ | Postal code → auto-provisions a comprehensive SD lineup (prefers DirecTV/Dish satellite; removes AFN) |
| `SD_DAYS` / `SD_TRANSPORT` / `SD_LINEUP` | `2` / auto / all | Days of guide / transport override / restrict to one lineup |
| `STREAM_SORT` | `quality` | `quality` = order feeds FHD>HD>SD>Audio (tvpass tiebreaker); `data` = keep harvester order |
| `GITHUB_RAW_BASE` | this repo @ `main` | Source for the roster/stream fetch leg |
| `DATA_REFRESH_HOURS` / `EPG_REFRESH_HOURS` | `6` / `6` | Roster + EPG re-fetch intervals |
| `RESPONSE_CACHE_SECS` | `300` | `cacheMaxAge` on catalog/meta/stream responses |
| `STREAM_BLOCKLIST_HOSTS` | `pluto.tv` | Stream hosts never served (comma-separated) |
| `STREAM_PRIORITY_HOSTS` | `tvpass.org` | Same-quality tiebreaker provider(s) sorted first |
| `PROXY_PUBLIC_URL` | _(unset)_ | Externally-reachable HTTPS base. When set, enables the stream proxy for fragile feeds |
| `PROXY_FORCE_HOSTS` | _(empty)_ | Extra host/URL substrings to force through the proxy |
| `PROXY_DISABLE` | _(unset)_ | `1` turns the proxy off (fragile feeds served direct, sorted last) |
| `PROXY_MANIFEST_TTL_MS` / `PROXY_MASTER_TTL_MS` | `2000` / `15000` | Micro-cache TTL for proxied media / master playlists |
| `DLHD_ENABLE` | `1` (on) | DaddyLive resolver — restores the ~71 channels that went dark when tvpass died. `0` disables |
| `DLHD_INCLUDE_EXTRA` | `1` (on) | Also offers DaddyLive as an HD alternate on the 59 channels that still have a free feed (130 mapped total). `0` = DARK channels only |
| `DLHD_BASE` / `DLHD_EMBED_HOST` | `https://dlhd.pk` / _(auto)_ | Follow DaddyLive domain rotations without a code change |
| `DLHD_TOKEN_MARGIN_MS` / `DLHD_RESOLVE_TIMEOUT_MS` | `120000` / `15000` | Re-resolve margin before the ~58 min token expiry / resolve timeout |
| `TZ` | `America/Denver` | Schedule display timezone |
| `LOG_LEVEL` | `info` | Set `debug` for per-request routing/cache/fetch logs |
| `NODE_OPTIONS` | `--max-old-space-size=3072` | Headroom for the ~188 MB EPG parse (needs ~4 GB) |

> Stremio Web requires HTTPS; for LAN/desktop use the raw `http://<host>:7001/manifest.json`, or front it with a reverse proxy / Cloudflare Tunnel for HTTPS. CI (`.github/workflows/docker.yml`) builds and pushes the image to GHCR on every push to `main`.

### EPG — merged multi-source guide

The server builds **one** guide by merging up to three tiers in priority order; each higher tier wins per channel and lower tiers only **fill gaps**:

1. **Schedules Direct** (optional, ~$35/yr) — accurate, feed-/timezone-correct US listings. Set `SD_USERNAME`/`SD_PASSWORD` + `SD_ZIP` and the server **auto-provisions** a comprehensive lineup via the SD API (prefers a national DirecTV/Dish satellite lineup; auto-removes the tiny AFN military lineup) — no manual lineup curation.
2. **epg.pw** (`EPG_URL`) — broad US XMLTV.
3. **epgshare01 + i.mjh.nz** (`EPGSHARE_URLS`) — FAST/streaming long-tail (Samsung TV Plus, Plex, Pluto, Roku) that the first two don't carry: AsianCrush, RetroCrush, Dark Matter, XITE, FilmRise, Vevo, etc.

Programmes from every source share one store via `sd:`/`pw:`/`es:` id prefixes. The roster is matched to EPG names with a two-phase matcher (exact/override across all tiers, then fuzzy) plus a curated override table. With no SD creds it runs epg.pw + epgshare01 only; any tier can fail independently. The parser handles **interleaved** XMLTV feeds (i.mjh.nz lists `<channel>` and its `<programme>`s together) and SD's per-(station,date) responses are accumulated across days so the full local day is covered. Diagnostics: `GET /debug/epg?full=1` (match report) and `GET /debug/schedule?ch=ABC` (a channel's loaded programmes in local time + last-fetch).

## Routes

| Stremio Resource | URL Path |
|---|---|
| Manifest | `/manifest.json` |
| Catalog | `/catalog/tv/all.json` |
| Catalog (genre) | `/catalog/tv/all/genre={Genre}.json` |
| Meta | `/meta/tv/{id}.json` |
| Stream | `/stream/tv/{id}.json` |
| Health | `/health` |
| EPG match report | `/debug/epg?full=1` |
| Channel schedule dump | `/debug/schedule?ch={name}` |
| DaddyLive resolve test | `/debug/dlhd?id={dlhd numeric id}` |

## Channel streams & sources

Each channel aims to offer **more than one stream to pick from** for reliability. Streams come from several layers, merged and quality-sorted (FHD > HD > SD) at request time:

- **Harvested feeds** — the curated static streams in `stream/tv/*.json` (iptv-org, famelack, FAST platforms, …), kept fresh by the harvester.
- **DaddyLive resolver** (`server/src/dlhd.js`) — when the proxy is active, **130 channels** get a live-resolved DaddyLive HD feed (`/dlhd/<id>/master.m3u8`). This **restored the ~71 premium/cable/sports channels that went dark when tvpass.org died** (ESPN family, RSNs, A&E/AMC/TBS/TNT/USA, CNBC/MSNBC, the HBO/Showtime/Starz/Cinemax multiplexes, Disney/Nick kids, Telemundo…) and adds an HD alternate to channels that still have a free feed (`DLHD_INCLUDE_EXTRA`, on by default). DaddyLive tokens are minted fresh per request and re-resolved before they expire, so playback is seamless; the client only ever sees a clean HLS URL on your host, so **the player needs no special handling**. Test a channel with `/debug/dlhd?id=<N>`.
- **Cross-source enrichment** — `iptvorg-enrich` and `famelack-enrich` add ffprobe-validated, deduped second feeds to existing channels.

Dead providers are filtered at runtime: blocklisted hosts (`pluto.tv`, the offline `tvpass.org`/`thetvapp.to`) and any feed a prior `consolidate` run tagged `[DEAD]` are never served. A handful of niche channels remain single-source where no second provider exists.

## Stream proxy (fragile-feed reliability)

Some upstream feeds are hard for a TV client to play directly — plain HTTP, raw-IP hosts, odd ports, or CDNs that 403 their HLS segments without a Referer/User-Agent (which shows up as a stream that won't load or buffers forever). Set **`PROXY_PUBLIC_URL`** to the addon's externally-reachable HTTPS base (e.g. behind a reverse proxy / Cloudflare Tunnel) and the server will:

- route only the **fragile** streams through its own `/proxy/<token>` endpoint (clean HTTPS streams stay direct — no extra load);
- fetch the upstream server-side with a browser User-Agent + same-origin Referer, follow redirects, accept any TLS cert;
- **rewrite HLS manifests** so variant playlists, segments, keys and audio tracks are fetched back through the proxy too (otherwise the player would hit the bare segment URLs and 403).

> **TVPass now requires the proxy.** tvpass.org 302-redirects each request to a load-balanced, IP-bound, tokenized host (`*.thetvapp.to`) — a naive player refreshing the live playlist gets a different host/token each time and 404s its segments (infinite buffer). The proxy gives the player one stable URL and handles the redirect/token/segment-rewriting from a single server IP, so **tvpass (the primary provider) and Google DAI are always proxied** (built-in `FORCE_PROXY_HOSTS`). This means the proxy must be active — i.e. run behind Tailscale Funnel / a public base — for tvpass to play.

> **Force-proxied feeds** (`server/src/streamHandler.js`): `tvpass.org`/`thetvapp.to` (token), `dai.google.com` and `*.a.run.app` (Google DAI / the `amd-mediator` SSAI front for CBS Sports Golazo — each mints a fresh DAI session per request, so direct playback buffers forever), `*.fast.nbcuni.com`, `*.amagi.tv`, `*.uplynk.com`, `*.mediatailor.*`, `*.tubi.io`/`*.tubi.video` (SSAI ad-stitchers — Amagi, Uplynk, AWS MediaTailor, Tubi/Yospace — that play a second of black then exit), and any URL carrying the XUMO SSAI marker `ads.xumo_channelId` (on plain CloudFront hosts). All are pinned to one server IP so the redirect+session chain stays consistent.

**Latency:** the proxy reuses upstream connections (keep-alive) and keeps a tiny TTL **manifest micro-cache** — media playlists ~2 s, masters ~15 s (`PROXY_MANIFEST_TTL_MS` / `PROXY_MASTER_TTL_MS`). This collapses the duplicate upstream fetches a live player makes (startup bursts, ABR switches, per-poll refreshes) without ever serving a stale live edge, and notably eases tvpass's burst throttling (the "tvpass is slow" symptom). Segments are never cached — only relayed.

The client only ever sees a clean HTTPS URL on your own host. The public base is **auto-detected from the request Host** (so behind Tailscale Funnel / a reverse proxy it needs no config); set `PROXY_PUBLIC_URL` to force an explicit base, or `PROXY_DISABLE=1` to turn it off (fragile streams then served directly, sorted last). The proxy relays video bytes, so size the host accordingly if many channels rely on it.

## Deploy with Tailscale Funnel (free, permanent HTTPS, no port-forwarding)

Tailscale Funnel gives a stable public URL `https://<hostname>.<tailnet>.ts.net` with automatic HTTPS and works behind NAT/CGNAT. The addon auto-detects that base, so the stream proxy turns on with **zero extra config**.

**Option A — Tailscale on the host (simplest):**
```bash
docker compose up -d --build           # addon on http://localhost:7001
tailscale funnel --bg 7001             # expose it at https://<host>.<tailnet>.ts.net
```
(enable HTTPS + Funnel for your tailnet once in the Tailscale admin.)

**Option B — fully containerized (Tailscale sidecar):**
```bash
export TS_AUTHKEY=tskey-auth-xxxxx      # from the Tailscale admin
docker compose -f docker-compose.funnel.yml up -d --build
```
This runs the addon + a `tailscale/tailscale` sidecar that funnels `:443 → 127.0.0.1:7001` via `tailscale/funnel.json`.

Either way, install in Stremio/Nuvio with:
```
https://<hostname>.<tailnet>.ts.net/manifest.json
```

## Provider policy

- **Quality-first stream ordering** (`STREAM_SORT=quality`, default) — each channel's feeds are ordered FHD > HD > SD > Audio, with **tvpass.org preferred as a same-quality tiebreaker** and the harvester's regional order kept as a final tiebreaker. This surfaces the best-quality feed (usually the one carrying WebVTT subtitles) as the default/auto-play stream. Set `STREAM_SORT=data` to keep the raw harvester order.
- **pluto.tv is blocked** — no longer accessible; filtered at injection time, purged by `clean`, and dropped at runtime by the server.
- famelack streams are tagged `FL`; other harvested streams use a host-based tag.
- **Subtitles**: streams set `behaviorHints.notWebReady=true` so the native HLS player surfaces in-manifest **WebVTT** subtitle renditions automatically (the proxy preserves them). Re-streamed feeds that carry only **CEA-608/708** in-band captions are handled by the NuvioTV fork's player (it exposes them as a selectable "Closed Captions" track).

## Data pipeline (the `harvester/`)

Python ≥3.10 managed with `uv`; stream testing needs `ffprobe` (ffmpeg). Run on a fast host (e.g. a Mac mini).

```bash
uv sync                                       # install deps

# discover + test + inject from 167 configured sources (sources.yaml)
uv run python -m harvester harvest            # scrape all sources for M3U/JSON streams
uv run python -m harvester test               # ffprobe-test (DNS pre-filter + ffprobe)
uv run python -m harvester inject             # match working streams to catalog channels
uv run python -m harvester run                # harvest + test + report in sequence
uv run python -m harvester prune              # remove dead streams from the catalog

# providers / maintenance
uv run python -m harvester clean              # purge blocklisted providers (Pluto) + reorder tvpass-first
uv run python -m harvester tvpass-discover --probe   # scrape tvpass directory, read real slugs, inject live links
uv run python -m harvester logos              # grab logos from iptv-org for channels missing local art

# famelack (famelack.com data, served as gzipped JSON on GitHub)
uv run python -m harvester famelack-enrich    # add validated famelack streams to EXISTING channels
uv run python -m harvester famelack-import --keyword telemundo --genre Latino --logo telemundo-us
                                              # import NEW channels (curated, deduped, ffprobe-validated)
```

Notes:
- `famelack-import` never creates duplicate channels — it drops geo-blocked entries and accent-folded name duplicates (vs the catalog and within the batch), and only imports channels with a working stream.
- `tvpass-discover --probe` is rate-limit aware (`--delay`, default 5s). Many RSN/sports feeds 404 when no live event is on, so re-run periodically.
- Logos: the repo already ships art for every current channel under `public/`. famelack has no logos; new channels fall back to the iptv-org open dataset.

## Sources

167 sources in `sources.yaml` across 6 handler types (`github`, `direct`, `website`, `telegram`, `paste`, `famelack`). Notably **famelack** (`harvester/sources/famelack.py`) reads famelack.com's full dataset (1361 US channels with direct stream URLs) straight from its public GitHub repo — no scraping. Pluto TV sources have been removed.

## Structure

```
manifest.json
catalog/tv/all.json                  # roster (293 channels)
catalog/tv/all/genre={Genre}.json    # per-genre slices
meta/tv/ustv-{uuid}.json
stream/tv/ustv-{uuid}.json
public/logo.png
public/background.jpg
public/logos/usa/{channel}.png
public/posters/usa/{channel}.png
server/                              # combined Node/Docker addon (see above)
harvester/                           # Python scrape/test/inject/import pipeline
.github/workflows/docker.yml         # CI: build + push image to GHCR
```
