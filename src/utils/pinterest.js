'use strict';

const axios = require('axios');
const cheerio = require('cheerio');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Realistic browser headers. Pinterest blocks bare axios/python requests,
 * so we mimic a modern Chrome browser.
 */
const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,' +
    'image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'max-age=0',
  DNT: '1',
  Connection: 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Sec-CH-UA': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  'Sec-CH-UA-Mobile': '?0',
  'Sec-CH-UA-Platform': '"Windows"',
};

/**
 * Preferred video qualities, highest first. Pinterest uses these keys inside
 * the `video_list` object.
 */
const VIDEO_QUALITY_PREFERENCE = [
  'V_1080P',
  'V_720P',
  'V_480P',
  'V_240P',
  'V_EXP7',
  'V_EXP6',
  'V_EXP5',
];

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

/**
 * Follows redirects to resolve a pin.it short URL to its canonical form.
 */
async function resolveShortUrl(url) {
  try {
    const res = await axios.get(url, {
      headers: BROWSER_HEADERS,
      maxRedirects: 10,
      timeout: 15_000,
      // Accept any 2xx/3xx status — we want the final URL after redirects
      validateStatus: (s) => s < 400,
    });
    // axios exposes the final URL after following redirects
    return res.request?.res?.responseUrl || res.config?.url || url;
  } catch (err) {
    throw new Error(`Unable to resolve short URL (${url}): ${err.message}`);
  }
}

/**
 * GETs a Pinterest pin page and returns the raw HTML string.
 */
async function fetchPage(url) {
  const res = await axios.get(url, {
    headers: BROWSER_HEADERS,
    timeout: 20_000,
    maxRedirects: 10,
  });
  return res.data;
}

// ---------------------------------------------------------------------------
// JSON extraction helpers
// ---------------------------------------------------------------------------

/**
 * Recursively walks `obj` collecting every value stored under `key`.
 * Returns an array of matches (may be empty).
 */
function deepFind(obj, key, _seen = new WeakSet()) {
  const results = [];
  if (typeof obj !== 'object' || obj === null) return results;
  // Guard against circular references
  if (_seen.has(obj)) return results;
  _seen.add(obj);

  if (Object.prototype.hasOwnProperty.call(obj, key)) {
    results.push(obj[key]);
  }
  for (const val of Object.values(obj)) {
    if (typeof val === 'object' && val !== null) {
      results.push(...deepFind(val, key, _seen));
    }
  }
  return results;
}

/**
 * Picks the best (highest-quality) MP4 URL from a Pinterest `video_list` map.
 * Returns { url, width?, height? } or null.
 */
function pickBestVideo(videoList) {
  if (!videoList || typeof videoList !== 'object') return null;

  for (const quality of VIDEO_QUALITY_PREFERENCE) {
    const entry = videoList[quality];
    if (entry?.url && !entry.url.includes('.m3u8')) {
      return { url: entry.url, width: entry.width, height: entry.height };
    }
  }

  // Fallback: grab the first non-HLS URL we find
  for (const entry of Object.values(videoList)) {
    if (entry?.url && !entry.url.includes('.m3u8')) {
      return { url: entry.url };
    }
  }
  return null;
}

/**
 * Picks the best still-image URL from a Pinterest `images` map.
 * Pinterest key order: orig > 736x > 474x > 236x
 */
function pickBestImage(images) {
  if (!images || typeof images !== 'object') return null;
  const preferredKeys = ['orig', '736x', '600x315', '474x', '236x', '170x'];
  for (const k of preferredKeys) {
    if (images[k]?.url) return images[k].url;
  }
  // Last resort: grab any url present
  for (const val of Object.values(images)) {
    if (val?.url) return val.url;
  }
  return null;
}

/**
 * Extracts the first non-empty string from an array (used for titles).
 */
function firstString(arr, fallback = '') {
  return arr.find((v) => typeof v === 'string' && v.trim().length > 0) || fallback;
}

// ---------------------------------------------------------------------------
// Data extraction strategies
// ---------------------------------------------------------------------------

/**
 * Strategy 1 — Parse `__PWS_INITIAL_DATA__` / `__PWS_DATA__` JSON that
 * Pinterest embeds in the page for server-side rendering.
 *
 * Pinterest may embed this in two forms:
 *   a) <script id="__PWS_DATA__">{…}</script>
 *   b) <script>window.__PWS_INITIAL_DATA__ = {…};</script>
 */
function extractFromPWSData(html, $) {
  let data = null;

  // (a) Inline JSON as the entire script body
  const inlineScript = $('#__PWS_DATA__').html();
  if (inlineScript) {
    try {
      data = JSON.parse(inlineScript.trim());
    } catch (_) { /* try next */ }
  }

  // (b) window assignment pattern
  if (!data) {
    $('script').each((_, el) => {
      if (data) return false; // already found — cheerio break
      const src = $(el).html() || '';
      if (!src.includes('__PWS_INITIAL_DATA__') && !src.includes('__PWS_DATA__')) return;

      // Find the position right after the first `=` that follows the key name
      const assignIdx = src.search(/(__PWS_INITIAL_DATA__|__PWS_DATA__)\s*=/);
      if (assignIdx === -1) return;

      const eqIdx = src.indexOf('=', assignIdx);
      const jsonStr = src.slice(eqIdx + 1).trim().replace(/;[\s\S]*$/, ''); // strip trailing ;…
      try {
        data = JSON.parse(jsonStr);
      } catch (_) { /* move on */ }
    });
  }

  if (!data) return null;

  // --- search for video data ---
  const videoLists = deepFind(data, 'video_list');
  for (const vl of videoLists) {
    const best = pickBestVideo(vl);
    if (!best) continue;

    // Find associated thumbnail
    const allImages = deepFind(data, 'images');
    let thumbnail = null;
    for (const img of allImages) {
      thumbnail = pickBestImage(img);
      if (thumbnail) break;
    }

    const title = firstString(deepFind(data, 'title'), 'Pinterest Video');

    return { type: 'video', media_url: best.url, thumbnail, title };
  }

  // --- fall back to image data ---
  const allImages = deepFind(data, 'images');
  for (const img of allImages) {
    const imageUrl = pickBestImage(img);
    if (!imageUrl) continue;

    const title = firstString(deepFind(data, 'title'), 'Pinterest Image');
    const type = imageUrl.toLowerCase().endsWith('.gif') ? 'gif' : 'image';

    return { type, media_url: imageUrl, thumbnail: imageUrl, title };
  }

  return null;
}

/**
 * Strategy 2 — Parse the plain inline <script> that carries `initialReduxState`.
 *
 * Pinterest no longer puts pin data in `__PWS_DATA__`. Instead it embeds the
 * full Redux store as a bare JSON object in a ~14 KB inline script:
 *
 *   <script>{"otaData":{…},"initialReduxState":{"pins":{…},"resources":{…}}}</script>
 *
 * Pin data lives in two possible sub-paths:
 *   a) initialReduxState.pins[pinId]          — direct pin object
 *   b) initialReduxState.resources.PinResource — cached API response
 */
function extractFromReduxState($) {
  let reduxState = null;

  $('script:not([src])').each((_, el) => {
    if (reduxState) return false;
    const src = ($(el).html() || '').trim();
    // The target script starts with { and contains initialReduxState
    if (!src.startsWith('{') || !src.includes('initialReduxState')) return;
    try {
      const parsed = JSON.parse(src);
      if (parsed.initialReduxState) {
        reduxState = parsed.initialReduxState;
      }
    } catch (_) { /* not valid JSON, skip */ }
  });

  if (!reduxState) return null;

  // --- path (a): initialReduxState.pins ---
  const pins = reduxState.pins;
  if (pins && typeof pins === 'object' && !Array.isArray(pins)) {
    for (const pin of Object.values(pins)) {
      const result = pinObjectToMedia(pin);
      if (result) return result;
    }
  }

  // --- path (b): initialReduxState.resources.PinResource ---
  const pinResource = reduxState.resources?.PinResource;
  if (pinResource && typeof pinResource === 'object') {
    for (const entry of Object.values(pinResource)) {
      // Each entry may be { status, data } or the pin object directly
      const pin = entry?.data ?? entry;
      const result = pinObjectToMedia(pin);
      if (result) return result;
    }
  }

  return null;
}

/**
 * Converts a Pinterest pin object to our standard media shape.
 * Handles three pin formats:
 *   1. Regular video pin  — pin.videos.video_list
 *   2. Idea / Story pin   — pin.story_pin_data.pages[].blocks[].video.video_list
 *   3. Image / GIF pin    — pin.images
 */
function pinObjectToMedia(pin) {
  if (!pin || typeof pin !== 'object') return null;

  const title = (typeof pin.title === 'string' && pin.title.trim())
    ? pin.title.trim()
    : (typeof pin.description === 'string' && pin.description.trim())
      ? pin.description.trim().slice(0, 120)
      : 'Pinterest';

  const thumbnail = pickBestImage(pin.images) || null;

  // --- Format 1: regular video pin (pin.videos.video_list) ---
  const videoList = pin.videos?.video_list;
  if (videoList) {
    const best = pickBestVideo(videoList);
    if (best) return { type: 'video', media_url: best.url, thumbnail, title };
  }

  // --- Format 2: Idea Pin / Story Pin (pin.story_pin_data) ---
  // Pages → blocks → block.video.video_list
  const pages = pin.story_pin_data?.pages;
  if (Array.isArray(pages)) {
    for (const page of pages) {
      for (const block of (page?.blocks || [])) {
        const storyVideoList = block?.video?.video_list ?? block?.block?.video?.video_list;
        if (storyVideoList) {
          const best = pickBestVideo(storyVideoList);
          if (best) {
            // Use page cover image as thumbnail if available
            const storyThumb = pickBestImage(page?.image) || thumbnail;
            return { type: 'video', media_url: best.url, thumbnail: storyThumb, title };
          }
        }
      }
    }
  }

  // --- Format 3: use deepFind as last resort for any video_list anywhere in pin ---
  const videoLists = deepFind(pin, 'video_list');
  for (const vl of videoLists) {
    const best = pickBestVideo(vl);
    if (best) return { type: 'video', media_url: best.url, thumbnail, title };
  }

  // --- Image / GIF pin ---
  if (thumbnail) {
    const type = thumbnail.toLowerCase().endsWith('.gif') ? 'gif' : 'image';
    return { type, media_url: thumbnail, thumbnail, title };
  }

  return null;
}

/**
 * Strategy 3 — OG / Twitter meta tags (reliable fallback, lower quality).
 */
function extractFromMetaTags($) {
  const get = (selectors) => {
    for (const sel of selectors) {
      const val = $(sel).attr('content');
      if (val) return val;
    }
    return null;
  };

  const videoUrl = get([
    'meta[property="og:video:secure_url"]',
    'meta[property="og:video:url"]',
    'meta[property="og:video"]',
    'meta[name="twitter:player:stream"]',
  ]);

  const imageUrl = get([
    'meta[property="og:image"]',
    'meta[name="twitter:image:src"]',
    'meta[name="twitter:image"]',
  ]);

  const title =
    get(['meta[property="og:title"]', 'meta[name="twitter:title"]']) ||
    $('title').text().replace(' | Pinterest', '').trim() ||
    'Pinterest';

  if (videoUrl) {
    return { type: 'video', media_url: videoUrl, thumbnail: imageUrl || null, title };
  }

  if (imageUrl) {
    const type = imageUrl.toLowerCase().endsWith('.gif') ? 'gif' : 'image';
    return { type, media_url: imageUrl, thumbnail: imageUrl, title };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Main entry point.
 *
 * Given a Pinterest pin URL (full or short), returns:
 * {
 *   type: 'video' | 'image' | 'gif',
 *   media_url: string,
 *   thumbnail: string | null,
 *   title: string,
 * }
 *
 * Throws on failure.
 */
async function extractPinterestMedia(url) {
  // 1. Resolve pin.it short links first
  if (/pin\.it\//i.test(url)) {
    url = await resolveShortUrl(url);
  }

  // 2. Fetch the pin page HTML
  const html = await fetchPage(url);
  const $ = cheerio.load(html);

  // 3. Strategy 1: initialReduxState inline script (current Pinterest structure)
  const reduxResult = extractFromReduxState($);
  if (reduxResult) return reduxResult;

  // 4. Strategy 2: __PWS_DATA__ / __PWS_INITIAL_DATA__ (older Pinterest structure)
  const pwsResult = extractFromPWSData(html, $);
  if (pwsResult) return pwsResult;

  // 5. Strategy 3: OG / Twitter meta tags (last resort fallback)
  const metaResult = extractFromMetaTags($);
  if (metaResult) return metaResult;

  // 5. Nothing worked
  throw Object.assign(
    new Error(
      'Could not extract media from this pin. ' +
      'The pin may be private, deleted, or Pinterest may have changed its page structure.',
    ),
    { statusCode: 422 },
  );
}

/**
 * Debug helper — returns raw data from all extraction sources for a pin page.
 * Used by the /api/debug-pin endpoint (development only).
 */
async function getRawPinState(url) {
  if (/pin\.it\//i.test(url)) url = await resolveShortUrl(url);
  const html = await fetchPage(url);
  const $ = cheerio.load(html);

  let reduxState = null;
  let pwsData = null;

  $('script:not([src])').each((_, el) => {
    const src = ($(el).html() || '').trim();
    if (!reduxState && src.startsWith('{') && src.includes('initialReduxState')) {
      try {
        const p = JSON.parse(src);
        if (p.initialReduxState) reduxState = p.initialReduxState;
      } catch (_) {}
    }
    if (!pwsData && (src.includes('__PWS_DATA__') || $(el).attr('id') === '__PWS_DATA__')) {
      try { pwsData = JSON.parse(src); } catch (_) {}
    }
  });

  // Also check <script id="__PWS_DATA__">
  if (!pwsData) {
    const inlineScript = $('#__PWS_DATA__').html();
    if (inlineScript) { try { pwsData = JSON.parse(inlineScript.trim()); } catch (_) {} }
  }

  // OG meta tags
  const ogImage = $('meta[property="og:image"]').attr('content') || null;
  const ogVideo = $('meta[property="og:video"]').attr('content') || $('meta[property="og:video:url"]').attr('content') || null;
  const ogTitle = $('meta[property="og:title"]').attr('content') || null;

  // Find all v.pinimg.com and i.pinimg.com URLs in raw HTML
  const videoUrls = [...new Set([...html.matchAll(/https:\/\/v\.pinimg\.com\/[^\s"'<]+\.mp4/g)].map(m => m[0]))];
  const imageUrls = [...new Set([...html.matchAll(/https:\/\/i\.pinimg\.com\/originals\/[^\s"'<]+/g)].map(m => m[0]))];

  return { reduxState, pwsData, ogImage, ogVideo, ogTitle, videoUrls, imageUrls };
}

module.exports = { extractPinterestMedia, getRawPinState };
