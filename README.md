# USA TV Next

173 live US TV channels across 10 genres: Local, News, Sports, Entertainment, Premium, Lifestyle, Kids, Documentaries, Music, Latino.

This repo ships the addon in **two modes**:

1. **Static** (`manifest.json` + `catalog/` + `meta/` + `stream/`) — hosted entirely on GitHub raw URLs, no server. Streams only, no live guide.
2. **Combined Docker server** (`server/`) — a single Node addon that serves catalog **+ EPG-enriched meta + streams** from one always-on instance. This is the merged successor to the separate `stremio-usatv-epg` guide addon: one install, no meta-resource collision, live Now Playing / Up Next / day schedule. **Recommended.**

> Install only ONE of these in a client. If you install both the static addon and the Docker addon they share the `ustv` id space and collide on the `meta` resource.

## Install (static)

Streams-only addon served straight from GitHub raw — no server, no live guide. Reflects the current **173-channel** catalog with Pluto removed and tvpass-prioritized streams. For live EPG (Now Playing / schedules) use the Combined Docker server below instead.

Stremio app (desktop / Android) — paste into the addon search bar, or open:

```
stremio://raw.githubusercontent.com/ConfidentlyIncorrect/usa-tv-next/main/manifest.json
```

[Install via Stremio Web](https://web.stremio.com/#/addons?addon=https%3A%2F%2Fraw.githubusercontent.com%2FConfidentlyIncorrect%2Fusa-tv-next%2Fmain%2Fmanifest.json)

> Manifest id `community.usa-tv-next` (v2.1.0). The catalog/meta/stream JSON is fetched relative to this URL, so it always serves the latest data on `main`. (The repo must stay public for raw URLs to resolve.)

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

**Hybrid data layer:** bundled local JSON (in the image) is the offline baseline; an interval (`DATA_REFRESH_HOURS`) fetches the latest roster from GitHub and writes an emergency cache to the `usatv-cache` volume. Read precedence is **live fetch → emergency cache → bundled local**, so the addon keeps working if GitHub access is lost. The EPG (`epg.pw`) is fetched on `EPG_REFRESH_HOURS` and its matched subset is cached to disk for cold-start resilience.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` / `HOST` | `7001` / `0.0.0.0` | HTTP bind |
| `EPG_URL` | epg.pw US XMLTV | EPG source (gz or plain) |
| `GITHUB_RAW_BASE` | this repo @ `main` | Source for the roster/stream fetch leg |
| `DATA_REFRESH_HOURS` | `6` | Roster fetch + emergency-cache interval |
| `EPG_REFRESH_HOURS` | `6` | EPG re-fetch interval |
| `STREAM_BLOCKLIST_HOSTS` | `pluto.tv` | Stream hosts never served (comma-separated) |
| `STREAM_PRIORITY_HOSTS` | `tvpass.org` | Stream hosts sorted to the top of each channel |
| `PROXY_PUBLIC_URL` | _(unset)_ | Externally-reachable HTTPS base. When set, enables the stream proxy for fragile feeds |
| `TZ` | `America/Denver` | Schedule display timezone |
| `LOG_LEVEL` | `info` | Set `debug` for per-request routing/cache/fetch logs |
| `NODE_OPTIONS` | `--max-old-space-size=3072` | Headroom for the ~188 MB EPG parse (needs ~4 GB) |

> Stremio Web requires HTTPS; for LAN/desktop use the raw `http://<host>:7001/manifest.json`, or front it with a reverse proxy / Cloudflare Tunnel for HTTPS. CI (`.github/workflows/docker.yml`) builds and pushes the image to GHCR on every push to `main`.

## Routes

| Stremio Resource | URL Path |
|---|---|
| Manifest | `/manifest.json` |
| Catalog | `/catalog/tv/all.json` |
| Catalog (genre) | `/catalog/tv/all/genre={Genre}.json` |
| Meta | `/meta/tv/{id}.json` |
| Stream | `/stream/tv/{id}.json` |

## Stream proxy (fragile-feed reliability)

Some upstream feeds are hard for a TV client to play directly — plain HTTP, raw-IP hosts, odd ports, or CDNs that 403 their HLS segments without a Referer/User-Agent (which shows up as a stream that won't load or buffers forever). Set **`PROXY_PUBLIC_URL`** to the addon's externally-reachable HTTPS base (e.g. behind a reverse proxy / Cloudflare Tunnel) and the server will:

- route only the **fragile** streams through its own `/proxy/<token>` endpoint (clean HTTPS streams stay direct — no extra load);
- fetch the upstream server-side with a browser User-Agent + same-origin Referer, follow redirects, accept any TLS cert;
- **rewrite HLS manifests** so variant playlists, segments, keys and audio tracks are fetched back through the proxy too (otherwise the player would hit the bare segment URLs and 403).

> **TVPass now requires the proxy.** tvpass.org 302-redirects each request to a load-balanced, IP-bound, tokenized host (`*.thetvapp.to`) — a naive player refreshing the live playlist gets a different host/token each time and 404s its segments (infinite buffer). The proxy gives the player one stable URL and handles the redirect/token/segment-rewriting from a single server IP, so **tvpass (the primary provider) and Google DAI are always proxied** (built-in `REDIRECT_PROVIDERS`). This means the proxy must be active — i.e. run behind Tailscale Funnel / a public base — for tvpass to play.

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

- **tvpass.org is prioritized** — its streams sort to the top of each channel (most stable provider). Tagged `TP`.
- **pluto.tv is blocked** — no longer accessible; filtered at injection time, purged by `clean`, and dropped at runtime by the server.
- famelack streams are tagged `FL`; other harvested streams use a host-based tag.
- All stream entries set `behaviorHints.notWebReady=true` so the native HLS player surfaces embedded subtitle tracks automatically.

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
catalog/tv/all.json                  # roster (173 channels)
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
