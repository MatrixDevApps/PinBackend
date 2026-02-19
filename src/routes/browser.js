'use strict';

const express = require('express');
const { validatePinterestUrl } = require('../utils/validators');
const { extractWithBrowser } = require('../utils/playwrightExtractor');

const router = express.Router();

/**
 * POST /api/extract/browser
 *
 * Body:    { "url": "https://www.pinterest.com/pin/..." }
 * Returns: { success, type, media_url, thumbnail, title }
 *
 * Uses Playwright headless Chromium to capture video URLs that Pinterest
 * loads entirely client-side (absent from static HTML). This endpoint is
 * slower (5–15 s) and more resource-intensive than POST /api/extract, so it
 * has a lower rate limit (5 req/min).
 */
router.post('/', async (req, res, next) => {
  try {
    const validation = validatePinterestUrl(req.body?.url);
    if (!validation.valid) {
      return res.status(400).json({ success: false, error: validation.error });
    }

    const media = await extractWithBrowser(validation.url);

    if (!media) {
      return res.status(422).json({
        success: false,
        error:
          'Could not extract media. The pin may be private, deleted, or ' +
          'use an unsupported format.',
      });
    }

    return res.json({
      success: true,
      type: media.type,
      media_url: media.media_url,
      thumbnail: media.thumbnail,
      title: media.title,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
