# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

PLDL (PlayList DownLoader) is a local web app that downloads YouTube playlists and recovers the titles of unavailable (deleted/private) videos via the Wayback Machine. A single-page frontend (`index.html`) is served statically by an Express backend (`server.js`) that shells out to `yt-dlp`. Two core library modules handle playlist enumeration and Wayback title recovery.

## Commands

```bash
npm install                                                 # install express + cors
node server.js                                              # start server on http://localhost:3001
                                                            # (also serves index.html statically)
python recover_playlist_titles.py input.txt output.csv      # optional standalone CLI recovery
```

External tools the backend depends on at runtime: `yt-dlp` and `ffmpeg` must be on PATH. `GET /api/health` reports the detected `yt-dlp` version and confirms lib modules loaded. The Python script additionally requires `pip install requests`.

There is no build, lint, or test setup.

## Architecture

### Files

- **`server.js`** - Express backend, port 3001. Serves `index.html` and the `lib/` modules statically via `express.static(__dirname)`. Five endpoints:
  - `GET /api/events` - SSE channel. All async progress (download and recovery) flows through here. Clients tracked in `sseClients` Map; `broadcast()` fans events to all connected clients.
  - `GET /api/playlist-info?url=` - calls `getPlaylist()` from `lib/playlist.js`, returns normalized video metadata including `available` and `availability` fields. Unavailable videos have `title: null` (their placeholder title is stripped before returning). If `YOUTUBE_API_KEY` is set, it also calls `getPlaylistItemDates()` from `lib/ytdata.js` and merges a `dateAdded` (date added to the playlist) and `videoPublishedAt` (original upload date) onto each video; both are `null` without a key or when not found.
  - `POST /api/download` - `{ url, outputDir, quality }` - spawns `yt-dlp`, responds immediately with `{ status: 'started' }`, then streams progress via SSE. Default output: `~/Downloads/YouTube Playlists/`. `quality` maps to a yt-dlp format selector via `formatMap` (`best`/`1080p`/`720p`/`480p`/`audio`).
  - `POST /api/recover` - `{ videoIds: string[] }` - runs two sequential passes: title recovery via `recoverTitles()` from `lib/recover.js`, then timeline estimation via `getTimeline()` from `lib/timeline.js`. Responds immediately with `{ status: 'started' }`, then streams recovery progress via SSE. `recover_progress` events include a `phase` field (`'titles'` | `'timeline'`).
  - `POST /api/download-recovered` - `{ videos: [{id,index,title,url,waybackSnapshot,availability}], outputDir? }` - best-effort recovery of unavailable videos from the Internet Archive via `recoverMedia()` in `lib/archive.js`. Responds `{ status: 'started' }`, processes videos sequentially, streams progress via SSE. Saves to a `Recovered/` subfolder of the output dir.
  - `GET /api/health` - reports yt-dlp version, whether lib modules loaded, and `ytApiKey` (whether `YOUTUBE_API_KEY` is configured).

- **`lib/playlist.js`** - Enumerates every video in a YouTube playlist via `yt-dlp --flat-playlist -J`. Returns available and unavailable videos in a single array with `available: boolean` and `availability: 'public'|'private'|'deleted'|'unlisted'|'unavailable'` per entry. Availability is classified from the placeholder title (`[Private video]`, `[Deleted video]`, `[Unavailable video]`) because the per-entry `availability` field is null in flat mode for all entries.

- **`lib/recover.js`** - Wayback Machine title recovery. For each video ID: queries the Wayback CDX API for the earliest 200-status snapshot, fetches it with the `id_` raw-content modifier (no toolbar rewrites), and extracts the title (prefers `og:title`, falls back to `<title>` with " - YouTube" stripped). Uses Node's global `fetch` (Node 18+). No npm dependencies. Concurrency: 3 simultaneous requests, 500ms delay between starts.

- **`lib/timeline.js`** - Wayback Machine snapshot-history bracketing. For each video ID: queries Wayback CDX for the full snapshot history, identifies `lastSeenAlive` (latest snapshot returning HTTP 200) and `firstSeenGone` (earliest 404/410 or later status after that), thereby bracketing the deletion window. Best-effort only - imperfect because some deleted YouTube pages still return HTTP 200, and archive.org must have crawled the page around its deletion. (The four investigative link-outs - Filmot, Ghostarchive, archive.today, Reddit search - are built client-side in `index.html` from the video ID, not here.)

- **`index.html`** - Single-page frontend. Vanilla JS, inline CSS, no framework, no bundler. Hardcodes backend at `const API = 'http://localhost:3001'`. Opens an `EventSource` to `/api/events` for live progress on both download and recovery.

- **`lib/archive.js`** - Best-effort video recovery from the Internet Archive. For each unavailable video, runs `yt-dlp "ytarchive:<id>"` (the `web.archive:youtube` extractor) to pull the archived video stream when Archive Team grabbed it; otherwise a second `--skip-download --write-thumbnail --write-info-json` pass saves whatever metadata/thumbnail is archived. Always writes a `<stem>.txt` sidecar with the recovered title + source URLs. Classifies each result as `video` | `thumbnail` | `metadata` | `none` by inspecting the files written for that filename stem.

- **`lib/ytdata.js`** - Optional YouTube Data API v3 enrichment. `getPlaylistItemDates(playlistId, apiKey)` paginates `playlistItems.list` (1 quota unit/call, 50/page) and returns a `Map<videoId, {dateAdded, videoPublishedAt, position}>` (ISO `YYYY-MM-DD` dates). The endpoint returns entries for deleted/private items too, so `dateAdded` works as an "alive on this date" signal where Wayback fails. Best-effort: a bad/missing key, quota exhaustion, or a private playlist returns an empty Map and never throws. The key is loaded from `.env` via `process.loadEnvFile()` at server startup (wrapped in try/catch; no dotenv dependency). `.env` is git-ignored; `.env.example` documents the variable.

- **`recover_playlist_titles.py`** - Standalone CLI, independent of the server. Same Wayback CDX logic as `lib/recover.js` but in Python, using `requests`. Kept as an optional offline fallback.

### SSE Event Types

Download events (from `POST /api/download`):
- `connected` - initial handshake with `clientId`
- `file_start` - `{ index, filename }` - yt-dlp starting a new file
- `progress` - `{ index, filename, percent, size, speed, eta }`
- `merging` - `{ index, filename }` - ffmpeg post-processing
- `file_done` - `{ index, filename, cached? }` - file complete
- `error` - `{ message }`
- `complete` - `{ code, outputDir, success }`

Recovery events (from `POST /api/recover`):
- `recover_progress` - `{ done, total, phase, current: { videoId, title } }` - `phase` is `'titles'` | `'timeline'`
- `recover_complete` - `{ results }` - full array of `{ videoId, title, url, waybackSnapshot, lastSeenAlive, firstSeenGone, snapshotCount }`
- `recover_error` - `{ message }`

Video-recovery events (from `POST /api/download-recovered`):
- `rdl_start` - `{ total, outputDir }`
- `rdl_item_start` - `{ index, total, id, title }`
- `rdl_item_done` - `{ index, total, id, title, outcome, files }` - outcome is `video` | `thumbnail` | `metadata` | `none`
- `rdl_complete` - `{ outputDir, results, videoCount }`

## Gotchas

- **yt-dlp stdout coupling** - Download progress is parsed by regex from yt-dlp's human-readable stdout line by line (`stdout.on('data')`). The regexes are brittle: if yt-dlp changes the wording of its `[download] Destination:`, `[download] N% of ...`, or `[download] ... has already been downloaded` lines, progress reporting silently breaks while downloads continue to complete normally.

- **Availability via placeholder title, not `availability` field** - In `--flat-playlist -J` mode, yt-dlp sets `availability: null` for every entry regardless of actual state. `lib/playlist.js` classifies availability by matching the entry's `title` against `/^\[private video\]$/i`, `/^\[deleted video\]$/i`, and `/^\[unavailable video\]$/i`. If yt-dlp changes these placeholder strings, classification breaks silently.

- **SSE indirection for both download and recovery** - Neither `POST /api/download` nor `POST /api/recover` delivers results in their HTTP responses. Both return `{ status: 'started' }` immediately and push all subsequent updates over `/api/events`. The frontend must open the SSE stream before (or concurrently with) sending the POST, or early events may be missed.

- **Output filenames** - yt-dlp uses the template `%(playlist_index|)s%(playlist_index& - |)s%(title)s.%(ext)s` with `--restrict-filenames`, `--windows-filenames`, and `--trim-filenames 180`. `cleanFilename()` in `server.js` is a separate sanitizer used only for the `cleanTitle` field returned by `/api/playlist-info` - it does not affect what yt-dlp writes to disk.

- **Investigative link services block bots** - Filmot, Ghostarchive, archive.today, and Reddit search all reject bot requests. `lib/timeline.js` builds the links server-side, but they are only suitable for human browser clicks, never pre-fetched by server-side code.
