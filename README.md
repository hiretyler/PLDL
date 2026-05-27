# PLDL - PlayList DownLoader

A local web app to download YouTube playlists AND recover the titles of videos that have since become unavailable (deleted/private) via the Wayback Machine.

---

## The Problem

You saved a YouTube playlist years ago. Some videos are now deleted or private. YouTube shows "N unavailable videos are hidden" with no titles, no IDs, nothing. PLDL solves two things at once:

1. **Full enumeration** - surfaces every video in the playlist, including unavailable ones with their real 11-character video IDs, without any browser dev-console hack.
2. **Title recovery** - queries the Wayback Machine to recover the original titles of deleted or private videos, so you know what you lost.

---

## Features

- Full playlist enumeration including unavailable (deleted/private) videos
- No browser dev-console step required
- Quality selection: best, 1080p, 720p, 480p, audio-only
- Live download progress via Server-Sent Events (per-file progress bar, speed, ETA)
- Wayback Machine title recovery with live progress for unavailable videos
- Deletion window estimation for unavailable videos via Wayback Machine snapshot history (bracketing when the video likely disappeared)
- Best-effort video recovery for unavailable videos from the Internet Archive (yt-dlp's `web.archive:youtube` extractor), falling back to thumbnail + metadata when the video stream was never archived
- Investigative link-outs for unavailable videos (Filmot, Ghostarchive, archive.today, Reddit search)
- "Date added to playlist" for every video via an optional YouTube Data API key (a reliable "alive on this date" signal, independent of archive.org)
- CSV export of recovered titles, investigative links, and recovered dates

---

## Requirements

- **Node.js 18+** (uses global `fetch`; tested on 25)
- **yt-dlp** and **ffmpeg** — used if already on your PATH, otherwise **downloaded automatically on first run** into `~/.pldl/bin`. (yt-dlp downloads reliably; ffmpeg's auto-download is best-effort per platform, and the app still works for non-merged formats if it's unavailable.) To install them yourself instead, see [yt-dlp](https://github.com/yt-dlp/yt-dlp#installation) and [ffmpeg](https://ffmpeg.org/download.html).

---

## Install & Run

```bash
npm install
node server.js
```

Open [http://localhost:3001](http://localhost:3001) in your browser.

To confirm yt-dlp is detected: `GET http://localhost:3001/api/health`

### Optional: date-added enrichment (YouTube Data API key)

If you provide a free YouTube Data API v3 key, PLDL also shows when each video was **added to the playlist** - a reliable "it was alive on this date" signal that doesn't depend on archive.org. It's entirely optional; everything else works without it.

```bash
cp .env.example .env   # then paste your key into .env as YOUTUBE_API_KEY=...
```

See `.env.example` for the 3-minute setup (Google Cloud Console -> enable "YouTube Data API v3" -> create an API key). The key is read server-side from `.env`, which is git-ignored.

---

## Usage

1. Paste a YouTube playlist URL into the input field and click **Analyze**.
2. PLDL enumerates the full playlist and shows two sections:
   - **Available videos** - can be downloaded.
   - **Unavailable videos** - deleted/private entries with their video IDs.
3. Select a quality (default: best) and click **Download All** to start. Live progress streams in real time.
4. For unavailable videos, click **Recover Titles** to query the Wayback Machine. Progress streams live as each ID is looked up.
5. Once recovery finishes, click **Export CSV** to download a spreadsheet with video ID, recovered title, and Wayback snapshot URL.

Downloaded files land in `~/Downloads/YouTube Playlists/` by default.

---

## How It Works

```
index.html (vanilla JS SPA)
    |
    |  GET  /api/playlist-info?url=
    |  POST /api/download
    |  POST /api/recover
    |  POST /api/download-recovered
    |  GET  /api/events  (SSE - live progress for download, title recovery, and video recovery)
    v
server.js (Express, port 3001)
    |-- lib/playlist.js  -- shells to yt-dlp --flat-playlist -J; classifies
    |                        available vs unavailable by placeholder title pattern
    |-- lib/recover.js   -- queries Wayback CDX API, fetches snapshots,
    |                        extracts og:title / <title> from archived HTML
    |-- lib/timeline.js  -- queries Wayback CDX snapshot history; brackets
    |                        deletion window via lastSeenAlive and firstSeenGone
    |-- lib/archive.js   -- shells to yt-dlp `ytarchive:<id>` to pull archived
    |                        videos from the Internet Archive; falls back to
    |                        thumbnail + metadata sidecar
    |-- lib/ytdata.js    -- optional: YouTube Data API v3 playlistItems lookup
                            for each item's date-added (needs YOUTUBE_API_KEY)
```

The server also serves `index.html` statically, so `node server.js` is the only process you need.

SSE (`/api/events`) is the single channel for all async progress - both yt-dlp download events and Wayback recovery events. The `POST /api/download` and `POST /api/recover` endpoints return immediately with `{ status: "started" }`; all subsequent updates arrive over the open SSE connection.

---

## Standalone Python Script

`recover_playlist_titles.py` is an optional CLI for offline title recovery. It takes a text file of video IDs (one per line) and writes a CSV. Useful if you already have a list of IDs and don't want to run the web app.

```bash
pip install requests
python recover_playlist_titles.py input.txt output.csv
```

---

## Limitations

- **Wayback hit rate** - recovery works well for popular videos that were archived frequently. Obscure videos may have no snapshot at all.
- **archive.org rate limits** - recovery is throttled deliberately (3 concurrent requests, 500ms delay) to stay polite. Large batches of unavailable videos will take a few minutes.
- **yt-dlp progress parsing** - download progress is derived by regex-matching yt-dlp's human-readable stdout. If yt-dlp changes its output format in a future version, progress display may silently break (downloads still complete).
