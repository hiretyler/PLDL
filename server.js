/**
 * YouTube Playlist Downloader - Backend Server
 * 
 * Prerequisites:
 *   npm install express cors
 *   Install yt-dlp: https://github.com/yt-dlp/yt-dlp#installation
 *   Install ffmpeg: https://ffmpeg.org/download.html
 * 
 * Run: node server.js
 */

const express = require('express');
const cors = require('cors');
const { exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { getPlaylist, extractPlaylistId } = require('./lib/playlist');
const { recoverTitles } = require('./lib/recover');
const { getTimelines } = require('./lib/timeline');
const { recoverMedia } = require('./lib/archive');
const { getPlaylistItemDates } = require('./lib/ytdata');

// Load optional .env (e.g. YOUTUBE_API_KEY) without an npm dependency.
try { process.loadEnvFile(); } catch { /* no .env file — enrichment stays off */ }

const app = express();
const PORT = 3001;

app.use(cors({ origin: '*' }));
app.use(express.json());

// Serve the PLDL frontend (index.html) so the whole app runs from `node server.js`
app.use(express.static(path.join(__dirname)));

// SSE clients registry
const sseClients = new Map();

/**
 * Broadcast an event to all connected SSE clients
 */
function broadcast(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach((res) => res.write(payload));
}

/**
 * Sanitize a title into a clean filename
 */
function cleanFilename(title) {
  return title
    .replace(/[<>:"/\\|?*]/g, '')       // Remove illegal chars
    .replace(/\s+/g, ' ')               // Collapse whitespace
    .replace(/\.+$/, '')                // Remove trailing dots
    .trim()
    .substring(0, 200);                 // Max length
}

// ─── SSE Stream ──────────────────────────────────────────────────────────────

app.get('/api/events', (req, res) => {
  const clientId = `${Date.now()}-${Math.random()}`;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  res.write(`data: ${JSON.stringify({ type: 'connected', clientId })}\n\n`);
  sseClients.set(clientId, res);

  req.on('close', () => {
    sseClients.delete(clientId);
  });
});

// ─── Playlist Info ────────────────────────────────────────────────────────────

app.get('/api/playlist-info', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  try {
    const data = await getPlaylist(url);

    // Optional enrichment: if a YouTube Data API key is configured, fetch the
    // date each item was added to the playlist (a reliable "alive on this date"
    // signal). Best-effort — failures leave dates null and never break listing.
    let dateMap = new Map();
    if (process.env.YOUTUBE_API_KEY) {
      const playlistId = extractPlaylistId(url);
      if (playlistId) {
        dateMap = await getPlaylistItemDates(playlistId, process.env.YOUTUBE_API_KEY);
      }
    }

    const videos = data.videos.map((v) => {
      const d = dateMap.get(v.id) || {};
      return {
        index: v.index,
        id: v.id,
        title: v.title,
        available: v.available,
        availability: v.availability,
        url: v.url,
        duration: v.duration,
        thumbnail: v.thumbnail,
        // Backward-compat: sanitized filename stem for the frontend's rendering.
        // Unavailable videos have a null title until recovered, so fall back to id.
        cleanTitle: cleanFilename(v.title || v.id || `Video_${v.index}`),
        // From YouTube Data API enrichment (null when no key / not found).
        dateAdded: d.dateAdded || null,
        videoPublishedAt: d.videoPublishedAt || null,
      };
    });

    res.json({
      title: data.title,
      uploader: data.uploader,
      count: data.count,
      availableCount: data.availableCount,
      unavailableCount: data.unavailableCount,
      videos,
    });
  } catch (err) {
    console.error('playlist-info error:', err);
    res.status(500).json({
      error: 'Failed to fetch playlist. Make sure yt-dlp is installed and the URL is valid.',
      detail: err.message,
    });
  }
});

// ─── Recover Titles + Deletion Timeline ─────────────────────────────────────────

app.post('/api/recover', (req, res) => {
  const { videoIds } = req.body;

  if (!Array.isArray(videoIds) || videoIds.length === 0) {
    return res.status(400).json({ error: 'videoIds must be a non-empty array' });
  }

  console.log(`Starting recovery (titles + timeline) for ${videoIds.length} video(s)`);

  res.json({ status: 'started', count: videoIds.length });

  // Two sequential passes (titles, then timeline) to stay polite to archive.org.
  (async () => {
    // Pass 1: title recovery.
    const titleResults = await recoverTitles(videoIds, {
      concurrency: 3,
      delayMs: 500,
      onProgress: ({ done, total, current }) => {
        broadcast({
          type: 'recover_progress',
          phase: 'titles',
          done,
          total,
          current: { videoId: current.videoId, title: current.title },
        });
      },
    });
    console.log(`Title pass complete: ${titleResults.length} result(s)`);

    // Pass 2: deletion-timeline lookup.
    const timelineResults = await getTimelines(videoIds, {
      concurrency: 3,
      delayMs: 500,
      onProgress: ({ done, total, current }) => {
        broadcast({
          type: 'recover_progress',
          phase: 'timeline',
          done,
          total,
          current: { videoId: current.videoId },
        });
      },
    });
    console.log(`Timeline pass complete: ${timelineResults.length} result(s)`);

    // Merge both passes by videoId, preserving input order (one object per id).
    const titleById = new Map(titleResults.map((r) => [r.videoId, r]));
    const timelineById = new Map(timelineResults.map((r) => [r.videoId, r]));

    const results = videoIds.map((videoId) => {
      const t = titleById.get(videoId) || {};
      const w = timelineById.get(videoId) || {};
      return {
        videoId,
        title: t.title ?? null,
        url: t.url ?? `https://www.youtube.com/watch?v=${videoId}`,
        waybackSnapshot: t.waybackSnapshot ?? null,
        lastSeenAlive: w.lastSeenAlive ?? null,
        firstSeenGone: w.firstSeenGone ?? null,
        snapshotCount: w.snapshotCount ?? 0,
      };
    });

    broadcast({ type: 'recover_complete', results });
    console.log(`Recovery complete: ${results.length} merged result(s)`);
  })().catch((err) => {
    console.error('Recovery failed:', err);
    broadcast({ type: 'recover_error', message: err.message });
  });
});

// ─── Download Recovered (from Internet Archive) ─────────────────────────────────

app.post('/api/download-recovered', async (req, res) => {
  const { videos, outputDir } = req.body;

  if (!Array.isArray(videos) || videos.length === 0) {
    return res.status(400).json({ error: 'videos must be a non-empty array' });
  }

  // Recovered files land in a "Recovered" subfolder of the playlist output dir.
  const baseDir = outputDir
    ? outputDir
    : path.join(os.homedir(), 'Downloads', 'YouTube Playlists');
  const finalDir = path.join(baseDir, 'Recovered');
  if (!fs.existsSync(finalDir)) {
    fs.mkdirSync(finalDir, { recursive: true });
  }

  console.log(`Starting archive recovery for ${videos.length} video(s) -> ${finalDir}`);
  res.json({ status: 'started', count: videos.length, outputDir: finalDir });

  broadcast({ type: 'rdl_start', total: videos.length, outputDir: finalDir });

  (async () => {
    const results = [];
    for (let i = 0; i < videos.length; i++) {
      const v = videos[i];
      const index = i + 1;
      // "01 - Title" style stem; fall back to the video id when no title.
      const indexLabel = (v.index != null ? v.index : index).toString().padStart(2, '0');
      const stem = cleanFilename(`${indexLabel} - ${v.title || v.id}`);

      broadcast({ type: 'rdl_item_start', index, total: videos.length, id: v.id, title: v.title || null });
      try {
        const result = await recoverMedia(v, finalDir, stem);
        results.push(result);
        broadcast({
          type: 'rdl_item_done',
          index,
          total: videos.length,
          id: v.id,
          title: result.title,
          outcome: result.outcome,        // 'video' | 'thumbnail' | 'metadata' | 'none'
          files: result.files,
        });
      } catch (err) {
        console.error(`Archive recovery failed for ${v.id}:`, err);
        results.push({ id: v.id, title: v.title || null, outcome: 'none', files: [], error: err.message });
        broadcast({ type: 'rdl_item_done', index, total: videos.length, id: v.id, title: v.title || null, outcome: 'none', error: err.message });
      }
    }
    const found = results.filter((r) => r.outcome === 'video').length;
    broadcast({ type: 'rdl_complete', outputDir: finalDir, results, videoCount: found });
    console.log(`Archive recovery complete: ${found}/${results.length} full videos recovered`);
  })();
});

// ─── Download ─────────────────────────────────────────────────────────────────

app.post('/api/download', (req, res) => {
  const { url, outputDir, quality = 'best' } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  // Default output directory: ~/Downloads/YouTube Playlists/
  const finalDir = outputDir
    ? outputDir
    : path.join(os.homedir(), 'Downloads', 'YouTube Playlists');

  if (!fs.existsSync(finalDir)) {
    fs.mkdirSync(finalDir, { recursive: true });
  }

  // Format selector based on quality preference
  const formatMap = {
    best:   'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best',
    '1080p':'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best',
    '720p': 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio/best',
    '480p': 'bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=480]+bestaudio/best',
    'audio': 'bestaudio[ext=m4a]/bestaudio',
  };
  const formatSelector = formatMap[quality] || formatMap['best'];

  // Output template: "01 - Clean Title.mp4"
  const outputTemplate = path.join(
    finalDir,
    '%(playlist_index|)s%(playlist_index& - |)s%(title)s.%(ext)s'
  );

  const args = [
    '-f', formatSelector,
    '--merge-output-format', quality === 'audio' ? 'm4a' : 'mp4',
    '-o', outputTemplate,
    '--restrict-filenames',        // safe filenames
    '--windows-filenames',         // cross-platform safe
    '--trim-filenames', '180',     // max filename length
    '--no-playlist-reverse',
    '--newline',
    '--progress',
    url,
  ];

  console.log('Starting download:', url);
  console.log('Output dir:', finalDir);

  res.json({ status: 'started', outputDir: finalDir });

  const ytdlp = spawn('yt-dlp', args);

  let currentFile = null;
  let currentIndex = 0;

  ytdlp.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    const lines = text.split('\n');

    lines.forEach((line) => {
      // Detect new file being downloaded
      const destMatch = line.match(/\[download\] Destination: (.+)/);
      if (destMatch) {
        currentFile = path.basename(destMatch[1]);
        currentIndex++;
        broadcast({ type: 'file_start', index: currentIndex, filename: currentFile });
        return;
      }

      // Already downloaded (cached)
      const alreadyMatch = line.match(/\[download\] (.+) has already been downloaded/);
      if (alreadyMatch) {
        broadcast({ type: 'file_done', index: currentIndex, filename: path.basename(alreadyMatch[1]), cached: true });
        return;
      }

      // Progress update
      const progressMatch = line.match(
        /\[download\]\s+(\d+\.?\d*)%\s+of\s+~?\s*([\d.]+\w+)\s+at\s+([\d.]+\w+\/s)\s+ETA\s+([\d:]+)/
      );
      if (progressMatch) {
        broadcast({
          type: 'progress',
          index: currentIndex,
          filename: currentFile,
          percent: parseFloat(progressMatch[1]),
          size: progressMatch[2],
          speed: progressMatch[3],
          eta: progressMatch[4],
        });
        return;
      }

      // Merger / post-processing
      if (line.includes('[Merger]') || line.includes('[ffmpeg]')) {
        broadcast({ type: 'merging', index: currentIndex, filename: currentFile });
        return;
      }

      // Done with single file
      const doneMatch = line.match(/\[download\] 100%/);
      if (doneMatch && currentFile) {
        broadcast({ type: 'file_done', index: currentIndex, filename: currentFile });
      }
    });
  });

  ytdlp.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    console.error('yt-dlp stderr:', text);
    if (text.includes('ERROR')) {
      broadcast({ type: 'error', message: text.trim() });
    }
  });

  ytdlp.on('close', (code) => {
    console.log(`yt-dlp exited with code ${code}`);
    broadcast({
      type: 'complete',
      code,
      outputDir: finalDir,
      success: code === 0,
    });
  });

  ytdlp.on('error', (err) => {
    console.error('Failed to start yt-dlp:', err);
    broadcast({ type: 'error', message: `Failed to start yt-dlp: ${err.message}. Is it installed?` });
  });
});

// ─── Health check ─────────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  const libs = {
    playlist: typeof getPlaylist === 'function',
    recover: typeof recoverTitles === 'function',
    timeline: typeof getTimelines === 'function',
    archive: typeof recoverMedia === 'function',
    ytdata: typeof getPlaylistItemDates === 'function',
  };
  exec('yt-dlp --version', (err, stdout) => {
    res.json({
      status: 'ok',
      ytdlp: err ? 'not found' : stdout.trim(),
      libs,
      ytApiKey: !!process.env.YOUTUBE_API_KEY,
    });
  });
});

app.listen(PORT, () => {
  console.log(`\n🎬 YouTube Playlist Downloader Backend`);
  console.log(`   Running at: http://localhost:${PORT}`);
  console.log(`   Health check: http://localhost:${PORT}/api/health\n`);
});
