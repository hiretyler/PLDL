/**
 * lib/ytdata.js — optional enrichment via the YouTube Data API v3.
 *
 * The Data API's playlistItems endpoint returns an entry for EVERY item in a
 * playlist, including deleted/private ones (title shows "Deleted video" /
 * "Private video"). Crucially, each entry carries `snippet.publishedAt` — the
 * date the item was ADDED to the playlist — which is a reliable "it was alive
 * on this date" signal that does not depend on archive.org having crawled it.
 * `contentDetails.videoPublishedAt` (original upload date) is also present for
 * many entries.
 *
 * Requires a free API key (process.env.YOUTUBE_API_KEY). A key alone suffices
 * for public playlists; no OAuth. If no key is set, callers skip enrichment.
 *
 * playlistItems.list costs 1 quota unit per call and returns 50 items/page, so
 * even a 300+ video playlist is a handful of units against the 10,000/day free
 * quota.
 */

const API_BASE = 'https://www.googleapis.com/youtube/v3/playlistItems';

function isoDate(ts) {
  // '2019-11-21T22:17:43Z' -> '2019-11-21'; null/garbage -> null
  if (!ts || typeof ts !== 'string') return null;
  const m = ts.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

/**
 * Fetch per-item dates for a whole playlist, paginating through all items.
 * @param {string} playlistId
 * @param {string} apiKey
 * @returns {Promise<Map<string,{dateAdded:string|null, videoPublishedAt:string|null, position:number|null}>>}
 *          keyed by videoId. Returns an empty Map on any failure (never throws).
 */
async function getPlaylistItemDates(playlistId, apiKey) {
  const byVideoId = new Map();
  if (!playlistId || !apiKey) return byVideoId;

  let pageToken = '';
  try {
    // Cap pages defensively (50 items/page * 40 = 2000 items) to avoid runaway loops.
    for (let page = 0; page < 40; page++) {
      const url =
        `${API_BASE}?part=snippet,contentDetails&maxResults=50` +
        `&playlistId=${encodeURIComponent(playlistId)}` +
        `&key=${encodeURIComponent(apiKey)}` +
        (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');

      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      const data = await res.json().catch(() => null);

      if (!res.ok || !data) {
        const msg = data && data.error ? data.error.message : `HTTP ${res.status}`;
        throw new Error(`YouTube Data API: ${msg}`);
      }

      for (const item of data.items || []) {
        const vid = item.snippet && item.snippet.resourceId && item.snippet.resourceId.videoId;
        if (!vid) continue;
        byVideoId.set(vid, {
          dateAdded: isoDate(item.snippet && item.snippet.publishedAt),
          videoPublishedAt: isoDate(item.contentDetails && item.contentDetails.videoPublishedAt),
          position: (item.snippet && typeof item.snippet.position === 'number') ? item.snippet.position : null,
        });
      }

      if (!data.nextPageToken) break;
      pageToken = data.nextPageToken;
    }
  } catch (err) {
    // Enrichment is best-effort: a bad key, quota exhaustion, or a private
    // playlist must not break enumeration. Log and return whatever we have.
    console.error('ytdata enrichment failed:', err.message);
  }

  return byVideoId;
}

module.exports = { getPlaylistItemDates };
