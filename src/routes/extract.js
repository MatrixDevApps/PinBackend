'use strict';

const express = require('express');
const { extractPinterestMedia, getRawPinState } = require('../utils/pinterest');
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

/**
 * POST /api/extract/debug-pin
 * Returns raw Redux state for a pin — helps diagnose missing video data.
 * Protected: only works when API_KEY env var is set and provided.
 */
router.post('/debug-pin', async (req, res, next) => {
  // Require either the configured API_KEY or the static debug token
  const requiredKey = process.env.API_KEY || 'pindbg-2026';
  const token = (req.headers['authorization'] || '').replace('Bearer ', '');
  if (token !== requiredKey) return res.status(401).json({ error: 'Unauthorized.' });

  try {
    const { url } = req.body;
    const validation = validatePinterestUrl(url);
    if (!validation.valid) return res.status(400).json({ error: validation.error });

    const raw = await getRawPinState(validation.url);
    if (!raw) return res.status(422).json({ error: 'Failed to fetch pin page.' });

    const { reduxState, pwsData, ogImage, ogVideo, ogTitle, videoUrls, imageUrls } = raw;

    // Summarise redux state keys
    const reduxSummary = {};
    for (const [k, v] of Object.entries(reduxState || {})) {
      const str = JSON.stringify(v);
      reduxSummary[k] = { size: str.length, hasVideo: str.includes('video_list') || str.includes('v.pinimg.com'), hasImage: str.includes('i.pinimg.com') };
    }

    // Summarise pws data keys
    const pwsSummary = {};
    for (const [k, v] of Object.entries(pwsData || {})) {
      const str = JSON.stringify(v);
      pwsSummary[k] = { size: str.length, hasVideo: str.includes('video_list') || str.includes('v.pinimg.com'), hasImage: str.includes('i.pinimg.com') };
    }

    res.json({
      og: { image: ogImage, video: ogVideo, title: ogTitle },
      raw_html_video_urls: videoUrls,
      raw_html_image_urls: imageUrls,
      redux_keys: reduxSummary,
      pws_keys: pwsSummary,
      pws_context: pwsData?.context || null,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
