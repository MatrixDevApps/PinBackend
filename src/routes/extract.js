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
  // Only allow if API_KEY is configured
  const requiredKey = process.env.API_KEY;
  if (!requiredKey) return res.status(403).json({ error: 'Debug endpoint requires API_KEY to be set.' });
  const token = (req.headers['authorization'] || '').replace('Bearer ', '');
  if (token !== requiredKey) return res.status(401).json({ error: 'Unauthorized.' });

  try {
    const { url } = req.body;
    const validation = validatePinterestUrl(url);
    if (!validation.valid) return res.status(400).json({ error: validation.error });

    const state = await getRawPinState(validation.url);
    if (!state) return res.status(422).json({ error: 'No Redux state found in page.' });

    const pins = state.pins || {};
    const pinResource = state.resources?.PinResource || {};

    res.json({
      pin_ids: Object.keys(pins),
      pins: pins,
      pinResource: pinResource,
      storyPinData: state.storyPinData || {},
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
