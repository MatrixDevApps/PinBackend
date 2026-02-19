'use strict';

const express = require('express');
const { extractPinterestMedia } = require('../utils/pinterest');
const { validatePinterestUrl } = require('../utils/validators');

const router = express.Router();

/**
 * POST /api/extract
 *
 * Body:   { "url": "https://pinterest.com/pin/..." }
 * Returns: { success, type, media_url, thumbnail, title }
 */
router.post('/', async (req, res, next) => {
  try {
    // 1. Validate input
    const validation = validatePinterestUrl(req.body?.url);
    if (!validation.valid) {
      return res.status(400).json({ success: false, error: validation.error });
    }

    // 2. Extract media — may throw on network / parse failures
    const media = await extractPinterestMedia(validation.url);

    // 3. Return success response
    return res.json({
      success: true,
      type: media.type,           // "video" | "image" | "gif"
      media_url: media.media_url, // direct download URL
      thumbnail: media.thumbnail, // preview image URL (may be null)
      title: media.title,         // pin title / description
    });
  } catch (err) {
    next(err); // delegate to errorHandler middleware
  }
});

module.exports = router;
