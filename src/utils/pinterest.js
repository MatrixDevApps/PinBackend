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
 * GETs a Pinterest pin page and returns the raw HTML string plus any
 * session cookies set by Pinterest (needed to authenticate API calls).
 */
async function fetchPage(url) {
  const res = await axios.get(url, {
    headers: BROWSER_HEADERS,
    timeout: 20_000,
    maxRedirects: 10,
  });

  // Collect cookies from Set-Cookie response headers so we can replay them
  // in subsequent API calls (Pinterest's /resource/ endpoints need a valid
  // csrftoken cookie to return data instead of 403).
  const setCookies = res.headers['set-cookie'] || [];
  const cookies = setCookies.map((c) => c.split(';')[0]).join('; ');

  return { html: res.data, cookies };
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
 * Upgrades a Pinterest CDN image URL to the highest available quality.
 * Pinterest CDN paths: /736x/ /474x/ /236x/ → /originals/
 */
function upgradeImageQuality(url) {
  if (!url) return url;
  return url.replace(/\/\d+x\//, '/originals/');
}

/**
 * Scans the raw HTML for the highest-quality image URL (originals).
 * Pinterest often preloads the original image even when og:image is 736x.
 */
function findOriginalImageInHtml(html, ogImageUrl) {
  if (!ogImageUrl) return null;

  // Extract the image hash from the og:image URL and look for originals version
  const hashMatch = ogImageUrl.match(/\/([a-f0-9]{32})\./);
  if (!hashMatch) return null;

  const hash = hashMatch[1];
  const parts = [hash.slice(0, 2), hash.slice(2, 4), hash.slice(4, 6)].join('/');
  const originalsPattern = new RegExp(
    `https://i\\.pinimg\\.com/originals/${parts}/${hash}\\.[a-z]+`, 'i'
  );
  const match = html.match(originalsPattern);
  return match ? match[0] : null;
}

/**
 * Strategy 3 — Pinterest Relay (GraphQL) response scripts.
 *
 * Modern Pinterest pages embed pin data via calls of the form:
 *   window.__PWS_RELAY_REGISTER_COMPLETED_REQUEST__("<url-encoded-query>", {raw JSON});
 *
 * The FIRST argument is a short URL-encoded query object (queryID + variables).
 * The SECOND argument is the raw JSON response containing all pin data, including
 * video URLs under keys like:
 *   videoList720P, videoList1080P, videoList480P  → direct MP4 files
 *   v_hlsv4_video_list, videoListMobile           → HLS (.m3u8) streams
 *
 * We prefer direct MP4 over HLS, and higher resolution over lower.
 */
function extractFromRelayScripts($) {
  // Quality-specific MP4 keys (e.g. videoList720P.v720P.url)
  const MP4_QUALITY_KEYS = [
    'videoList1080P', 'videoList720P', 'videoList480P', 'videoList360P', 'videoList240P',
    // Mixed-quality list: videoList.v720P.url or videoList.vHLSV4.url
    'videoList',
  ];
  const HLS_KEYS = ['v_hlsv4_video_list', 'videoListMobile', 'videoList'];

  const MARKER = '__PWS_RELAY_REGISTER_COMPLETED_REQUEST__("';
  let bestResult = null;

  $('script:not([src])').each((_, el) => {
    if (bestResult) return false;
    const src = $(el).html() || '';
    if (!src.includes(MARKER)) return;

    // Find where the first (URL-encoded) argument ends: look for `",` pattern
    const markerIdx = src.indexOf(MARKER);
    const firstArgEnd = src.indexOf('",', markerIdx + MARKER.length);
    if (firstArgEnd === -1) return;

    // Second argument starts right after `", ` (the comma-space separator)
    const secondArgStart = firstArgEnd + 2;
    const secondArgRaw = src.slice(secondArgStart);

    // The second argument is a raw JSON object; it ends just before `});`
    const closingIdx = secondArgRaw.lastIndexOf('});');
    const jsonStr = closingIdx !== -1
      ? secondArgRaw.slice(0, closingIdx + 1) // include the final `}`
      : secondArgRaw.slice(0, secondArgRaw.lastIndexOf('}') + 1);

    let json;
    try {
      json = JSON.parse(jsonStr);
    } catch (_) { return; }

    // Grab thumbnail and title from the response
    const thumbCandidates = deepFind(json, 'thumbnail');
    const thumbnail =
      thumbCandidates.find((t) => typeof t === 'string' && t.includes('pinimg.com')) ||
      $('meta[property="og:image"]').attr('content') ||
      null;
    const titleCandidates = [...deepFind(json, 'pinTitle'), ...deepFind(json, 'description')];
    const title =
      titleCandidates.find((t) => typeof t === 'string' && t.trim()) || 'Pinterest Video';

    // Try MP4 keys first
    for (const key of MP4_QUALITY_KEYS) {
      const videoLists = deepFind(json, key);
      for (const vl of videoLists) {
        if (!vl || typeof vl !== 'object') continue;
        for (const entry of Object.values(vl)) {
          if (entry?.url && !entry.url.includes('.m3u8')) {
            bestResult = { type: 'video', media_url: entry.url, thumbnail, title };
            return false;
          }
        }
      }
    }

    // Fall back to HLS
    for (const key of HLS_KEYS) {
      const videoLists = deepFind(json, key);
      for (const vl of videoLists) {
        if (!vl || typeof vl !== 'object') continue;
        for (const entry of Object.values(vl)) {
          if (entry?.url) {
            bestResult = { type: 'video', media_url: entry.url, thumbnail, title };
            return false;
          }
        }
      }
    }
  });

  return bestResult;
}

/**
 * Strategy 4 — OG / Twitter meta tags.
 * Pinterest reliably serves og:image and og:title for all public pins.
 * For video pins: og:video is often absent (video loads client-side),
 * so we return the best available image as the media URL.
 */
function extractFromMetaTags($, html) {
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

  const ogImageUrl = get([
    'meta[property="og:image"]',
    'meta[name="twitter:image:src"]',
    'meta[name="twitter:image"]',
  ]);

  const title =
    get(['meta[property="og:title"]', 'meta[name="twitter:title"]']) ||
    $('title').text().replace(' | Pinterest', '').trim() ||
    'Pinterest';

  if (videoUrl) {
    const thumbnail = ogImageUrl || null;
    return { type: 'video', media_url: videoUrl, thumbnail, title };
  }

  if (ogImageUrl) {
    // Try to get originals quality instead of 736x
    const originalsUrl = findOriginalImageInHtml(html, ogImageUrl) || upgradeImageQuality(ogImageUrl);
    const type = originalsUrl.toLowerCase().endsWith('.gif') ? 'gif' : 'image';
    return { type, media_url: originalsUrl, thumbnail: ogImageUrl, title };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Pinterest internal API (Strategy 0)
// ---------------------------------------------------------------------------

/**
 * Extracts the numeric pin ID from a canonical Pinterest pin URL.
 * e.g. https://www.pinterest.com/pin/774124931181173/ → "774124931181173"
 */
function extractPinId(url) {
  const m = url.match(/\/pin\/([a-zA-Z0-9_-]+)\/?/);
  return m ? m[1] : null;
}

/**
 * Strategy 0 — Pinterest's internal PinResource XHR API.
 *
 * Pinterest's own frontend fetches pin data (including video_list) via:
 *   GET /resource/PinResource/get/?data={"options":{"id":"PIN_ID",...}}
 *
 * The endpoint requires the session cookies that Pinterest sets when the
 * page first loads (particularly csrftoken). We pass the cookies collected
 * during fetchPage() so this call is authenticated the same way a real
 * browser would be.
 *
 * @param {string} pinId
 * @param {string} cookies  Raw "name=value; name2=value2" cookie string
 */
async function extractFromApi(pinId, cookies) {
  // Extract CSRF token from the cookie string
  const csrfMatch = (cookies || '').match(/csrftoken=([^;]+)/);
  const csrfToken = csrfMatch ? csrfMatch[1] : '';

  const data = JSON.stringify({
    options: { id: pinId, field_set_key: 'unauth_react' },
    context: {},
  });

  const apiUrl =
    `https://www.pinterest.com/resource/PinResource/get/` +
    `?data=${encodeURIComponent(data)}&_=${Date.now()}`;

  let res;
  try {
    res = await axios.get(apiUrl, {
      headers: {
        ...BROWSER_HEADERS,
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        'X-CSRFToken': csrfToken,
        Referer: `https://www.pinterest.com/pin/${pinId}/`,
        Cookie: cookies || '',
      },
      timeout: 15_000,
    });
  } catch (_) {
    // Non-fatal: fall through to HTML-based strategies
    return null;
  }

  const pin = res.data?.resource_response?.data;
  if (!pin) return null;

  return pinObjectToMedia(pin);
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

  // 2. Fetch the pin page HTML + session cookies in one request
  const { html, cookies } = await fetchPage(url);
  const $ = cheerio.load(html);
  const pinId = extractPinId(url);

  // 3. Strategy 0: Pinterest internal API (uses session cookies from step 2)
  //    This is the only reliable way to get video URLs for video pins.
  if (pinId) {
    const apiResult = await extractFromApi(pinId, cookies);
    if (apiResult) return apiResult;
  }

  // 4. Strategy 1: initialReduxState inline script (current Pinterest structure)
  const reduxResult = extractFromReduxState($);
  if (reduxResult) return reduxResult;

  // 5. Strategy 2: __PWS_DATA__ / __PWS_INITIAL_DATA__ (older Pinterest structure)
  const pwsResult = extractFromPWSData(html, $);
  if (pwsResult) return pwsResult;

  // 6. Strategy 3: Relay (GraphQL) scripts — videoList720P / v_hlsv4_video_list
  const relayResult = extractFromRelayScripts($);
  if (relayResult) return relayResult;

  // 7. Strategy 4: OG / Twitter meta tags (last resort fallback)
  const metaResult = extractFromMetaTags($, html);
  if (metaResult) return metaResult;

  throw Object.assign(
    new Error(
      'Could not extract media from this pin. ' +
      'The pin may be private, deleted, or Pinterest may have changed its page structure.',
    ),
    { statusCode: 422 },
  );
}

module.exports = { extractPinterestMedia, extractPinId, extractFromApi, fetchPage };
