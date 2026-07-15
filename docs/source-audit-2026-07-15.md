# Source and roster audit — 2026-07-15

## Scope

This audit compared every retained channel assignment with freshly downloaded upstream data and the current DaddyLive channel directory. It tested both reachability and channel identity; a URL returning video was not considered valid unless its feed matched the roster entry.

Reproducible source copies and machine-readable probe results are stored under the gitignored `data/audits/2026-07-15/` directory. The new `python -m harvester snapshot-sources` command can repeat the configured-source and legacy-source capture.

## Inputs captured

- Current Famelack US dataset (1,541 channels)
- iptv-org US playlist, channel metadata, and stream metadata
- Current DaddyLive 24/7 directory (899 parsed entries)
- 167 configured sources from `sources.yaml`
- 40 legacy discovery sites from the workspace `sources.txt`

The generalized source snapshot deduplicated those definitions into 207 endpoints. It saved 204 local responses; 197 returned HTTP 2xx. The remaining ten were three 403 responses, three 404 responses, one 410 response, and three DNS failures. The manifest records each source id, requested and final URL, status, content type, byte count, SHA-256 digest, truncation state, and error.

## Findings

The pre-audit catalog had 293 channels and 300 static assignments. An exact provenance comparison covered 260 assignments. Playback probing found 54 dead URLs among 294 unique static URLs, dominated by the retired `23.237.104.106:8080` origin.

Several working URLs had rotated to a different channel or had always represented a similarly branded FAST channel rather than the parent network. Confirmed examples included ABC 20/20 or KTNV/CW Las Vegas assigned to ABC, Fox Soul assigned to Fox, History Hit assigned to History, and Telemundo Al Día assigned to Telemundo. Other rejected substitutions included branded feeds from Lifetime, MSG, News12, PBS, CBS, QVC, Reelz, TV One, Bravo, FanDuel, BET, and Fox News.

The Famelack schema changed from top-level `stream_urls` to `sources.streams`. The previous parser would silently return no current streams. The parser now supports both schemas and rejects non-HTTP values.

All 130 prior DaddyLive ids still existed, but ids 891, 893, and 894 had rotated from regional FanDuel feeds to Big Brother camera feeds. Those mappings were removed. Current mappings were added for FS1 (39), Lifetime Movie Network (389), Nickelodeon (330), and National Geographic Wild (745).

## Applied curation

- Removed 81 dead, rotated, or identity-mismatched static assignments.
- Added 23 fresh, working assignments whose upstream identity matched the roster.
- Removed 13 channels with no verified static or dynamic source: HLN, FanDuel Detroit, FanDuel Great Lakes, FanDuel Indiana, Gol TV, Hallmark Family, Samuel Goldwyn Classics, 5StarMax, MoreMax, BET Her, Go2Travel, MeTV Toons, and MTV2.
- Reclassified the DaddyLive map from actual post-audit static coverage: 95 `DARK` mappings and 36 `EXTRA` mappings, 131 total.
- Fixed ffprobe timeout cleanup so timed-out child processes are killed and reaped.
- Added `DATA_REMOTE_ENABLE=0` to this direct deployment so the still-old published branch and its emergency cache cannot replace the audited bundled roster. Re-enable remote refresh after publishing the same dataset.

## Post-audit invariants

- 280 catalog entries, 280 metadata files, and 280 stream files; no missing or orphan files.
- 241 retained static assignments. A complete post-refresh ffprobe run passed 241/241 with zero failures or timeouts.
- 95 channels have empty static stream files; every one has an unconditional `DARK` DaddyLive mapping.
- 131 distinct roster entries map to 131 distinct current DaddyLive ids. All ids exist in the current directory and their labels match the intended channel.
- Every roster channel has at least one retained static or dynamic source.

## Repeat procedure

```bash
python -m harvester snapshot-sources
python -m harvester harvest
python -m harvester test
```

After automated liveness testing, review channel identity before injection. Rebuild `DARK` and `EXTRA` from the final static files, then verify catalog/meta/stream cardinality and probe the production proxy path after deployment.

## Production verification

The audited catalog and server were deployed to `/opt/usa-tv-next` with a rollback copy at `/opt/usa-tv-next-backups/20260715T172015Z-source-audit`. The existing compose customizations, environment file, Gluetun sidecar, and deployment log were preserved; only `DATA_REMOTE_ENABLE=0` was added to the live compose environment.

Post-deployment checks:

- Container healthy with 280 channels and 131 DaddyLive mappings; no application errors in the post-test log window.
- Live catalog pagination returned 100, 100, and 80 entries.
- ABC traversed the public proxy through master and media playlists to a 206 MPEG-TS segment response.
- New DaddyLive mappings 39, 389, 330, and 745 all returned valid HLS masters.
- FS1 traversed DaddyLive master and media handling to a 206 segment response.

## Damitv follow-up

After the 280-channel audit baseline was deployed, `https://damitv.st/livetv` and its current app/API were inspected separately. Its 878-channel Live TV directory maps numeric ids into a DaddyLive-style proxy and did not provide an independent replacement source; representative playlist requests returned HTTP 502. The prior 13 removed channels were not recovered there.

Damitv's `/papi/api/streams` endpoint also exposes a small persistent section. Every relevant entry was resolved and checked for actual video identity rather than playlist reachability alone: COWS, Family Guy, and The Simpsons were unavailable, South Park and SpongeBob returned image-file loops, and Rally TV returned live MPEG-TS video visibly branded as Rally TV. Rally TV was therefore added as roster entry 281 (Sports entry 48) through the token-refreshing `server/src/damitv.js` resolver. Signed upstream URLs are never stored statically; the stable player endpoint is `/damitv/rally-tv/master.m3u8`.
