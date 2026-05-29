# USA TV Next

190 live TV channels across 10 genres: Sports, Entertainment, News, Premium, Kids, Lifestyle, Documentaries, Local, Music, Latino.

This repo ships the addon in **two modes**:

1. **Static** (`manifest.json` + `catalog/` + `meta/` + `stream/`) — hosted entirely on GitHub raw URLs, no server. Streams only, no live guide.
2. **Combined Docker server** (`server/`) — a single Node addon that serves catalog **+ EPG-enriched meta + streams** from one always-on instance. This is the merged successor to the separate `stremio-usatv-epg` guide addon: one install, no meta-resource collision, live Now Playing / Up Next / day schedule.

## Install (static)

```
stremio://raw.githubusercontent.com/yowmamasita/usa-tv-next/main/manifest.json
```

[Install via Stremio Web](https://web.stremio.com/#/addons?addon=https%3A%2F%2Fraw.githubusercontent.com%2Fyowmamasita%2Fusa-tv-next%2Fmain%2Fmanifest.json)

## Combined Docker server (`server/`)

A single addon (`community.usa-tv-next`) providing `catalog` + `meta` + `stream` for the `ustv` id space, with an integrated EPG.

```bash
docker compose up -d --build
curl -s http://localhost:7001/manifest.json     # should list catalog, meta, stream
```

**Hybrid data layer:** bundled local JSON (in the image) is the offline baseline; an interval (`DATA_REFRESH_HOURS`) fetches the latest roster from GitHub and writes an emergency cache to the `usatv-cache` volume. Read precedence is **live fetch → emergency cache → bundled local**, so the addon keeps working if GitHub access is lost. The EPG (`epg.pw`) is fetched on `EPG_REFRESH_HOURS` and its matched subset is cached to disk for cold-start resilience.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` / `HOST` | `7001` / `0.0.0.0` | HTTP bind |
| `EPG_URL` | epg.pw US XMLTV | EPG source (gz or plain) |
| `GITHUB_RAW_BASE` | this repo @ `main` | Source for the roster/stream fetch leg |
| `DATA_REFRESH_HOURS` | `6` | Roster fetch + emergency-cache interval |
| `EPG_REFRESH_HOURS` | `6` | EPG re-fetch interval |
| `TZ` | `America/Denver` | Schedule display timezone |
| `LOG_LEVEL` | `info` | Set `debug` for per-request routing/cache/fetch logs |
| `NODE_OPTIONS` | `--max-old-space-size=3072` | Headroom for the ~188 MB EPG parse (needs ~4 GB) |

> Stremio Web requires HTTPS; for LAN/desktop use the raw `http://<host>:7001/manifest.json`, or front it with a reverse proxy / Cloudflare Tunnel for HTTPS.

## Routes

| Stremio Resource | URL Path |
|---|---|
| Manifest | `/manifest.json` |
| Catalog | `/catalog/tv/all.json` |
| Catalog (genre) | `/catalog/tv/all/genre={Genre}.json` |
| Meta | `/meta/tv/{id}.json` |
| Stream | `/stream/tv/{id}.json` |

## Structure

```
manifest.json
catalog/tv/all.json
catalog/tv/all/genre={Genre}.json
meta/tv/ustv-{uuid}.json
stream/tv/ustv-{uuid}.json
public/logo.png
public/background.jpg
public/logos/usa/{channel}.png
public/posters/usa/{channel}.png
```
