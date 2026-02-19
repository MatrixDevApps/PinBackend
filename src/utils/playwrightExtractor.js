'use strict';

const { chromium } = require('playwright');
const { extractPinId, extractFromApi } = require('./pinterest');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VIDEO_QUALITY_PREFERENCE = [
  'V_1080P', 'V_720P', 'V_480P', 'V_360P', 'V_240P',
  'V_EXP7', 'V_EXP6', 'V_EXP5',
];

// ---------------------------------------------------------------------------
// Helpers (mirrored from pinterest.js to keep this module self-contained)
// ---------------------------------------------------------------------------

function pickBestVideo(videoList) {
  if (!videoList || typeof videoList !== 'object') return null;
  for (const q of VIDEO_QUALITY_PREFERENCE) {
    const entry = videoList[q];
    if (entry?.url && !entry.url.includes('.m3u8')) {
      return { url: entry.url, width: entry.width, height: entry.height };
    }
  }
  for (const entry of Object.values(videoList)) {
    if (entry?.url && !entry.url.includes('.m3u8')) {
      return { url: entry.url };
    }
  }
  return null;
}

function deepFind(obj, key, seen = new WeakSet()) {
  const results = [];
  if (!obj || typeof obj !== 'object') return results;
  if (seen.has(obj)) return results;
  seen.add(obj);
  if (Object.prototype.hasOwnProperty.call(obj, key)) results.push(obj[key]);
  for (const val of Object.values(obj)) {
    if (val && typeof val === 'object') results.push(...deepFind(val, key, seen));
  }
  return results;
}

// ---------------------------------------------------------------------------
// Browser extraction
// ---------------------------------------------------------------------------

/**
 * Extracts media from a Pinterest pin using headless Chromium.
 *
 * First tries Pinterest's internal API directly (fast path, no browser needed).
 * Falls back to full browser navigation if the API call returns no video,
 * intercepting XHR responses and v.pinimg.com video CDN requests.
 *
 * @param {string} pinUrl  Canonical Pinterest pin URL
 * @returns {{ type, media_url, thumbnail, title } | null}
 */
async function extractWithBrowser(pinUrl) {
  // Fast path: try the Pinterest internal API first (same XHR the browser makes)
  const pinId = extractPinId(pinUrl);
  if (pinId) {
    const apiResult = await extractFromApi(pinId);
    // Only return the API result if it found a video — for images the regular
    // /api/extract endpoint is already sufficient, so here we only short-circuit
    // when we actually get a video URL.
    if (apiResult?.type === 'video') return apiResult;
  }

  // Full browser path — needed when the API is blocked or returns no video
  let browser = null;
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--single-process',
        // Prevent Pinterest from detecting headless/automation
        '--disable-blink-features=AutomationControlled',
      ],
    });

    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'en-US',
      viewport: { width: 1280, height: 800 },
      // Mimic a real browser that has been used before
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    // Hide navigator.webdriver — the main signal Pinterest uses to detect bots
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    const page = await context.newPage();

    // Captured data
    const capturedVideoUrls = new Set();
    let bestVideoFromApi = null;
    let thumbnail = null;
    let title = 'Pinterest Video';

    // --- Intercept responses ---
    page.on('response', async (response) => {
      const url = response.url();

      // Direct MP4 video file requests from Pinterest's video CDN
      if (/v\.pinimg\.com/i.test(url) && /\.mp4/i.test(url)) {
        capturedVideoUrls.add(url.split('?')[0]);
        return;
      }

      // Pinterest API responses that carry pin data with video_list
      if (
        response.status() === 200 &&
        (url.includes('/resource/PinResource/') ||
          url.includes('/api/v3/pins/') ||
          url.includes('/v3/pins/'))
      ) {
        try {
          const ct = response.headers()['content-type'] || '';
          if (!ct.includes('json')) return;
          const json = await response.json().catch(() => null);
          if (!json || bestVideoFromApi) return;

          const videoLists = deepFind(json, 'video_list');
          for (const vl of videoLists) {
            const best = pickBestVideo(vl);
            if (best?.url) {
              bestVideoFromApi = best.url;
              break;
            }
          }
        } catch (_) { /* ignore parse errors */ }
      }
    });

    // Also watch outgoing requests for MP4 URLs (request fires before response)
    page.on('request', (request) => {
      const url = request.url();
      if (/v\.pinimg\.com/i.test(url) && /\.mp4/i.test(url)) {
        capturedVideoUrls.add(url.split('?')[0]);
      }
    });

    // Navigate and wait for network to settle
    await page.goto(pinUrl, { waitUntil: 'networkidle', timeout: 30_000 });

    // Grab meta-tag title and thumbnail
    try {
      const rawTitle = await page.title();
      title = rawTitle.replace(/ \| Pinterest$/i, '').trim() || title;
    } catch (_) {}
    try {
      thumbnail = await page
        .$eval('meta[property="og:image"]', (el) => el.getAttribute('content'))
        .catch(() => null);
    } catch (_) {}

    // If nothing captured yet, scroll to trigger lazy loading
    if (capturedVideoUrls.size === 0 && !bestVideoFromApi) {
      await page.evaluate(() => window.scrollTo(0, 400)).catch(() => {});
      await page.waitForTimeout(2_000);
    }

    // Try clicking the play button to force video load
    if (capturedVideoUrls.size === 0 && !bestVideoFromApi) {
      try {
        const playBtn = page
          .locator('[aria-label="Play"], [data-test-id="play-button"]')
          .first();
        const visible = await playBtn.isVisible({ timeout: 2_000 }).catch(() => false);
        if (visible) {
          await playBtn.click();
          await page.waitForTimeout(3_000);
        }
      } catch (_) {}
    }

    // Last resort: scan page source for embedded v.pinimg.com MP4 references
    if (capturedVideoUrls.size === 0 && !bestVideoFromApi) {
      try {
        const found = await page.evaluate(() => {
          const html = document.documentElement.innerHTML;
          const matches = html.match(/https:\/\/v\.pinimg\.com\/[^"'\s]+\.mp4/gi);
          return matches ? [...new Set(matches)] : [];
        });
        for (const u of found) capturedVideoUrls.add(u);
      } catch (_) {}
    }

    // Resolve best video URL
    const videoUrl =
      bestVideoFromApi ||
      (capturedVideoUrls.size > 0 ? pickBestCapturedUrl([...capturedVideoUrls]) : null);

    if (videoUrl) {
      return { type: 'video', media_url: videoUrl, thumbnail, title };
    }

    // Fallback: return best available image
    if (thumbnail) {
      const type = thumbnail.toLowerCase().endsWith('.gif') ? 'gif' : 'image';
      return { type, media_url: thumbnail, thumbnail, title };
    }

    return null;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

/**
 * From a list of captured MP4 URLs, prefer higher-resolution ones.
 * Pinterest encodes quality in the path (e.g. /1080P/, /720P/).
 */
function pickBestCapturedUrl(urls) {
  const resolutions = ['1080', '720', '480', '360', '240'];
  for (const r of resolutions) {
    const match = urls.find((u) => u.includes(r));
    if (match) return match;
  }
  // Prefer longer/more-specific paths as a rough quality heuristic
  return urls.sort((a, b) => b.length - a.length)[0];
}

module.exports = { extractWithBrowser };
