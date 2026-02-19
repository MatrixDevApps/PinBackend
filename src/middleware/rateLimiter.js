'use strict';

const rateLimit = require('express-rate-limit');

/**
 * Rate limiter for the /api/extract endpoint.
 * Allows up to 30 requests per minute per IP address.
 *
 * Headers returned to the client:
 *   RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset  (RFC-6585)
 */
const extractLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute window
  max: 30,             // max requests per window
  standardHeaders: 'draft-7', // modern RateLimit-* headers
  legacyHeaders: false,

  // Custom JSON response on limit exceeded
  handler(req, res) {
    res.status(429).json({
      success: false,
      error: 'Rate limit exceeded. You may make up to 30 requests per minute.',
      retryAfter: Math.ceil(req.rateLimit.resetTime / 1000 - Date.now() / 1000),
    });
  },

  // Key by IP; if behind a proxy set `app.set('trust proxy', 1)`
  keyGenerator: (req) => req.ip,
});

/**
 * Rate limiter for the /api/extract/browser endpoint.
 * Lower limit (5 req/min) because each request spawns a full browser instance.
 */
const browserLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,

  handler(req, res) {
    res.status(429).json({
      success: false,
      error: 'Rate limit exceeded. Browser extraction allows up to 5 requests per minute.',
      retryAfter: Math.ceil(req.rateLimit.resetTime / 1000 - Date.now() / 1000),
    });
  },

  keyGenerator: (req) => req.ip,
});

module.exports = { extractLimiter, browserLimiter };
