'use strict';

/**
 * recover.js
 *
 * Wayback Machine title-recovery for deleted/unavailable YouTube videos.
 * Ports recover_playlist_titles.py to Node.js using the global fetch API
 * (Node >= 18). No external npm dependencies.
 *
 * Exported API:
 *   recoverTitle(videoId)                        -> Promise<RecoveryResult>
 *   recoverTitles(videoIds, options)             -> Promise<RecoveryResult[]>
 *
 * RecoveryResult shape:
 *   { videoId, title, url, waybackSnapshot }
 *     title           – recovered title string, or null if not found
 *     url             – canonical https://www.youtube.com/watch?v=<id>
 *     waybackSnapshot – human-viewable snapshot URL or null
 */

const CDX_API    = 'http://web.archive.org/cdx/search/cdx';
const WAYBACK    = 'https://web.archive.org/web';
const USER_AGENT = 'Mozilla/5.0 (playlist-title-recovery; +https://github.com/user/pldl)';

// Regex mirrors from the Python script
const OG_TITLE_RE   = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i;
// Also handle the reversed attribute order: content first, then property
const OG_TITLE_RE2  = /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i;
const TITLE_TAG_RE  = /<title[^>]*>([\s\S]*?)<\/title>/i;
const YT_SUFFIX_RE  = /\s*-\s*YouTube\s*$/i;

// ─── AbortSignal timeout helper (Node 17.3+ has AbortSignal.timeout) ─────────

function timeoutSignal(ms) {
  if (typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), ms);
  return ctrl.signal;
}

// ─── CDX lookup ───────────────────────────────────────────────────────────────

/**
 * Query the Wayback CDX API for the earliest 200-status snapshots of
 * youtube.com/watch?v=<videoId> (deduped by content digest). Returns an array
 * of timestamp strings, earliest first — empty on any failure.
 */
async function findSnapshots(videoId, limit = 5) {
  const params = new URLSearchParams({
    url:      `youtube.com/watch?v=${videoId}`,
    output:   'json',
    filter:   'statuscode:200',
    collapse: 'digest',
    limit:    String(limit),
  });
  const url = `${CDX_API}?${params}`;

  // The CDX API routinely takes 10s+ server-side and drops the odd request,
  // so allow a generous timeout and one retry.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal:  timeoutSignal(30_000),
      });
      if (!res.ok) {
        console.error(`  CDX HTTP ${res.status} for ${videoId}`);
        return [];
      }
      const rows = await res.json();
      // rows[0] is the header row; data rows follow
      if (!Array.isArray(rows) || rows.length < 2) return [];
      // CDX JSON columns: urlkey, timestamp, original, mimetype, statuscode, digest, length
      return rows.slice(1).map((r) => r[1]).filter(Boolean);
    } catch (err) {
      console.error(`  CDX lookup failed for ${videoId} (attempt ${attempt}): ${err.message}`);
    }
  }
  return [];
}

// ─── Snapshot fetch + title extraction ───────────────────────────────────────

/**
 * Extract the first balanced JSON object that follows `anchorRe` in `html`
 * and return it parsed, or null. String-aware brace matching (handles
 * escapes), so nested objects and braces inside string values are fine.
 */
function extractJsonAfter(html, anchorRe) {
  const m = anchorRe.exec(html);
  if (!m) return null;
  const start = html.indexOf('{', m.index + m[0].length - 1);
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(html.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

// Matches `window["ytInitialPlayerResponse"] =`, `var ytInitialPlayerResponse =`, etc.
const PLAYER_RESPONSE_RE = /ytInitialPlayerResponse["'\]]*\s*=\s*\{/;

/**
 * Fetch the raw Wayback snapshot (id_ modifier = no toolbar/rewrites) and
 * extract the video title. Returns the title string, null when the page has
 * no title, or the DEAD_PAGE sentinel when the archived page itself says the
 * video was already removed/unavailable at crawl time.
 */
const DEAD_PAGE = Symbol('dead-page');

async function fetchTitle(videoId, timestamp) {
  const watchUrl   = `https://www.youtube.com/watch?v=${videoId}`;
  const snapshotUrl = `${WAYBACK}/${timestamp}id_/${watchUrl}`;

  let html;
  try {
    const res = await fetch(snapshotUrl, {
      headers: { 'User-Agent': USER_AGENT },
      signal:  timeoutSignal(20_000),
    });
    if (!res.ok) {
      console.error(`  Snapshot HTTP ${res.status} for ${videoId}`);
      return null;
    }
    html = await res.text();
  } catch (err) {
    console.error(`  Fetch failed for ${videoId}: ${err.message}`);
    return null;
  }

  // Prefer og:title (most reliable in archived YouTube HTML)
  let m = OG_TITLE_RE.exec(html) || OG_TITLE_RE2.exec(html);
  if (m) return decodeHtmlEntities(m[1].trim());

  // Fall back to <title> tag. Old pages wrap/indent the text and use either
  // "<title> - YouTube" (suffix) or "YouTube - <title>" (2009-era prefix).
  m = TITLE_TAG_RE.exec(html);
  if (m) {
    const raw = decodeHtmlEntities(m[1])
      .replace(/\s+/g, ' ')
      .trim()
      .replace(YT_SUFFIX_RE, '')
      .replace(/^YouTube\s*-\s*/i, '')
      .trim();
    if (raw) return raw;
  }

  // Modern client-rendered pages (2018+) have no server-rendered title tags;
  // the title lives in the embedded ytInitialPlayerResponse JSON instead.
  const pr = extractJsonAfter(html, PLAYER_RESPONSE_RE);
  if (pr) {
    const title = pr.videoDetails && pr.videoDetails.title;
    if (title && String(title).trim()) return String(title).trim();
    const status = pr.playabilityStatus && pr.playabilityStatus.status;
    if (status && status !== 'OK') return DEAD_PAGE; // crawled after removal
  }

  return null;
}

// ─── HTML entity decoder (no external dep needed for the subset YouTube uses) ─

const HTML_ENTITIES = {
  '&amp;':  '&',
  '&lt;':   '<',
  '&gt;':   '>',
  '&quot;': '"',
  '&#39;':  "'",
  '&apos;': "'",
  '&#x27;': "'",
  '&nbsp;': ' ',
};

function decodeHtmlEntities(str) {
  // Numeric decimal &#NNN; and hex &#xNNN;
  str = str.replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
    String.fromCodePoint(parseInt(hex, 16))
  );
  str = str.replace(/&#([0-9]+);/g, (_, dec) =>
    String.fromCodePoint(parseInt(dec, 10))
  );
  // Named entities (common subset)
  str = str.replace(/&[a-z]+;/gi, (entity) =>
    HTML_ENTITIES[entity] ?? entity
  );
  return str;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Recover the original title for a single YouTube video ID via the Wayback Machine.
 *
 * @param {string} videoId  11-character YouTube video ID
 * @returns {Promise<{videoId:string, title:string|null, url:string, waybackSnapshot:string|null}>}
 */
async function recoverTitle(videoId) {
  const url = `https://www.youtube.com/watch?v=${videoId}`;

  const timestamps = await findSnapshots(videoId);
  if (timestamps.length === 0) {
    return { videoId, title: null, url, waybackSnapshot: null };
  }

  // Walk distinct 200 snapshots earliest-first until one yields a title.
  // A DEAD_PAGE result (page crawled after removal) just moves on — a later
  // digest-distinct capture is occasionally a re-crawl of the live page.
  for (const ts of timestamps) {
    const title = await fetchTitle(videoId, ts);
    if (typeof title === 'string') {
      return { videoId, title, url, waybackSnapshot: `${WAYBACK}/${ts}/${url}` };
    }
  }

  // No title anywhere; still link the earliest snapshot for manual digging.
  return { videoId, title: null, url, waybackSnapshot: `${WAYBACK}/${timestamps[0]}/${url}` };
}

/**
 * Recover titles for multiple video IDs with controlled concurrency and rate
 * limiting. Results are returned in the same order as the input array.
 * A failure for any single ID yields title:null without throwing.
 *
 * @param {string[]} videoIds  Array of 11-char YouTube video IDs
 * @param {object}  [options]
 * @param {number}  [options.concurrency=3]  Max simultaneous requests
 * @param {number}  [options.delayMs=500]    ms to wait between starting each request
 * @param {function}[options.onProgress]     Called as ({done, total, current}) after each video
 * @returns {Promise<Array<{videoId,title,url,waybackSnapshot}>>}
 */
async function recoverTitles(videoIds, { concurrency = 3, delayMs = 500, onProgress } = {}) {
  const total   = videoIds.length;
  const results = new Array(total);
  let done      = 0;

  // We process with a sliding-window concurrency gate.
  // Each slot is a promise; we push up to `concurrency` at once,
  // then await the earliest before adding another.
  const queue = [...videoIds.entries()]; // [[index, id], ...]
  const active = new Set();

  async function runOne([index, id]) {
    let result;
    try {
      result = await recoverTitle(id);
    } catch (err) {
      // Should never reach here (recoverTitle never throws), but be safe.
      result = {
        videoId: id,
        title: null,
        url: `https://www.youtube.com/watch?v=${id}`,
        waybackSnapshot: null,
      };
    }
    results[index] = result;
    done++;
    if (typeof onProgress === 'function') {
      onProgress({ done, total, current: result });
    }
  }

  // Sliding window: keep up to `concurrency` tasks in flight
  const inFlight = [];

  for (const item of queue) {
    // Enforce polite delay between *starting* each request
    if (inFlight.length > 0 && delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }

    // If already at capacity, wait for the oldest task to finish
    if (inFlight.length >= concurrency) {
      await inFlight.shift();
    }

    const p = runOne(item);
    inFlight.push(p);
  }

  // Drain remaining
  await Promise.all(inFlight);

  return results;
}

module.exports = { recoverTitle, recoverTitles };
