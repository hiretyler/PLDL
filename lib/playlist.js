/**
 * lib/playlist.js
 *
 * Enumerate EVERY video in a YouTube playlist - including videos that are now
 * unavailable (deleted, private, region-blocked) - given only a playlist URL.
 *
 * Method: shells out to yt-dlp with `--flat-playlist -J`. Empirically (see the
 * module's accompanying research notes) yt-dlp:
 *   - paginates through the ENTIRE playlist server-side (verified on 1000+ and
 *     300+ video playlists), so there is no 100-item lazy-load cap, and
 *   - INCLUDES unavailable videos as entries with their real 11-char video IDs
 *     and a placeholder title of "[Private video]" or "[Deleted video]"
 *     (YouTube hides these from the default web page behind an "N unavailable
 *     videos are hidden" message, but yt-dlp surfaces them).
 *
 * The per-entry `availability` field is unreliable in flat mode (it is null for
 * every entry, available or not), so availability is derived from the placeholder
 * title instead.
 *
 * Dependency-free: uses only Node's built-in child_process + the yt-dlp binary
 * that the project already requires to be on PATH.
 *
 * @module lib/playlist
 */

'use strict';

const { execFile } = require('child_process');

// yt-dlp can take a while on very large playlists; give it generous headroom.
const YTDLP_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const MAX_BUFFER = 200 * 1024 * 1024; // 200 MB of JSON for huge playlists

const PRIVATE_RE = /^\[private video\]$/i;
const DELETED_RE = /^\[deleted video\]$/i;
const UNAVAILABLE_RE = /^\[unavailable video\]$/i;

/**
 * Extract the playlist id (the `list=` parameter) from any YouTube URL, or accept
 * a bare playlist id. Throws if no plausible playlist id can be found.
 *
 * @param {string} input - playlist URL, watch URL containing list=, or bare id.
 * @returns {string} the playlist id.
 */
function extractPlaylistId(input) {
  if (typeof input !== 'string' || !input.trim()) {
    throw new Error('A playlist URL or id is required.');
  }
  const raw = input.trim();

  // Bare playlist id (no scheme/host). Playlist ids are URL-safe tokens.
  if (!/[/:?=&]/.test(raw) && /^[A-Za-z0-9_-]{10,}$/.test(raw)) {
    return raw;
  }

  let listId = null;
  try {
    const u = new URL(raw);
    listId = u.searchParams.get('list');
  } catch (_) {
    // Not a parseable URL; fall through to regex.
  }
  if (!listId) {
    const m = raw.match(/[?&]list=([A-Za-z0-9_-]+)/);
    if (m) listId = m[1];
  }
  if (!listId) {
    throw new Error(
      `Could not find a playlist id (list=...) in: ${input}. ` +
        'Provide a playlist URL, a watch URL containing a list= parameter, or a bare playlist id.'
    );
  }
  return listId;
}

/**
 * Run yt-dlp and return the parsed flat-playlist JSON object.
 *
 * @param {string} playlistUrl - canonical playlist URL.
 * @returns {Promise<object>} parsed yt-dlp -J output.
 */
function runYtDlp(playlistUrl) {
  const args = [
    '--flat-playlist',
    '-J', // dump single JSON for the whole playlist
    '--ignore-errors', // do not abort the whole run on individual entry errors
    '--no-warnings',
    '--extractor-args',
    // PLAYLIST is the most reliable extractor for full enumeration of a list.
    'youtubetab:skip=authcheck',
    playlistUrl,
  ];

  return new Promise((resolve, reject) => {
    execFile(
      'yt-dlp',
      args,
      { timeout: YTDLP_TIMEOUT_MS, maxBuffer: MAX_BUFFER },
      (err, stdout, stderr) => {
        // yt-dlp may exit non-zero with --ignore-errors yet still have produced
        // valid JSON on stdout, so try to parse before treating err as fatal.
        const out = (stdout || '').trim();
        if (out) {
          try {
            return resolve(JSON.parse(out));
          } catch (parseErr) {
            // fall through to error handling below
          }
        }
        if (err) {
          const detail = (stderr || err.message || '').trim();
          if (err.killed || err.signal === 'SIGTERM') {
            return reject(
              new Error(`yt-dlp timed out after ${YTDLP_TIMEOUT_MS / 1000}s for ${playlistUrl}.`)
            );
          }
          return reject(new Error(`yt-dlp failed for ${playlistUrl}: ${detail}`));
        }
        return reject(
          new Error(`yt-dlp returned no parseable JSON for ${playlistUrl}.`)
        );
      }
    );
  });
}

/**
 * Pick the largest thumbnail URL from a yt-dlp thumbnails array.
 *
 * @param {Array} thumbnails
 * @returns {string|null}
 */
function bestThumbnail(thumbnails) {
  if (!Array.isArray(thumbnails) || thumbnails.length === 0) return null;
  let best = null;
  let bestArea = -1;
  for (const t of thumbnails) {
    if (!t || !t.url) continue;
    const area = (t.width || 0) * (t.height || 0);
    if (area >= bestArea) {
      bestArea = area;
      best = t.url;
    }
  }
  return best || thumbnails[thumbnails.length - 1].url || null;
}

/**
 * Classify a flat-playlist entry into an availability state.
 *
 * @param {object} entry - a yt-dlp flat-playlist entry.
 * @returns {{ available: boolean, availability: string|null }}
 */
function classify(entry) {
  const title = typeof entry.title === 'string' ? entry.title.trim() : '';

  if (PRIVATE_RE.test(title)) {
    return { available: false, availability: 'private' };
  }
  if (DELETED_RE.test(title)) {
    return { available: false, availability: 'deleted' };
  }
  if (UNAVAILABLE_RE.test(title)) {
    return { available: false, availability: 'unavailable' };
  }

  // No id at all, or no usable title -> treat as unavailable (rare).
  if (!entry.id || !title) {
    return { available: false, availability: 'unavailable' };
  }

  // yt-dlp's per-entry `availability` is usually null in flat mode, but honor it
  // when present (e.g. 'unlisted').
  const av = typeof entry.availability === 'string' ? entry.availability : null;
  if (av && av !== 'public') {
    // unlisted videos are still downloadable -> available true.
    return { available: true, availability: av };
  }
  return { available: true, availability: 'public' };
}

/**
 * Enumerate every video in a YouTube playlist, including unavailable ones.
 *
 * @param {string} url - playlist URL, watch URL with list=, or bare playlist id.
 * @returns {Promise<{
 *   title: string|null,
 *   uploader: string|null,
 *   count: number,
 *   availableCount: number,
 *   unavailableCount: number,
 *   videos: Array<{
 *     index: number,
 *     id: string|null,
 *     title: string|null,
 *     available: boolean,
 *     availability: 'public'|'private'|'deleted'|'unlisted'|'unavailable'|string|null,
 *     url: string|null,
 *     duration: number|null,
 *     thumbnail: string|null
 *   }>
 * }>}
 */
async function getPlaylist(url) {
  const playlistId = extractPlaylistId(url);
  const canonicalUrl = `https://www.youtube.com/playlist?list=${playlistId}`;

  const data = await runYtDlp(canonicalUrl);

  if (!data || typeof data !== 'object') {
    throw new Error(`Unexpected yt-dlp output for playlist ${playlistId}.`);
  }

  const entries = Array.isArray(data.entries) ? data.entries : [];
  if (entries.length === 0) {
    // yt-dlp returned a JSON object but with no entries: most likely an invalid,
    // empty, or non-existent/unviewable playlist.
    throw new Error(
      `No videos found for playlist ${playlistId}. It may be empty, private, or non-existent.`
    );
  }

  const videos = [];
  let availableCount = 0;
  let unavailableCount = 0;

  entries.forEach((entry, i) => {
    const { available, availability } = classify(entry);
    if (available) availableCount += 1;
    else unavailableCount += 1;

    const id = typeof entry.id === 'string' ? entry.id : null;
    const rawTitle = typeof entry.title === 'string' ? entry.title.trim() : null;
    // For unavailable videos the "title" is a placeholder; null it out so callers
    // know there is no real title yet (to be recovered from the Wayback Machine).
    const title = available ? rawTitle : null;

    videos.push({
      index: i + 1,
      id,
      title,
      available,
      availability,
      url: id ? `https://www.youtube.com/watch?v=${id}` : entry.url || null,
      duration:
        typeof entry.duration === 'number' && !Number.isNaN(entry.duration)
          ? entry.duration
          : null,
      thumbnail: bestThumbnail(entry.thumbnails),
    });
  });

  return {
    title: typeof data.title === 'string' ? data.title : null,
    uploader:
      (typeof data.uploader === 'string' && data.uploader) ||
      (typeof data.channel === 'string' && data.channel) ||
      null,
    count: videos.length,
    availableCount,
    unavailableCount,
    videos,
  };
}

module.exports = { getPlaylist, extractPlaylistId };
