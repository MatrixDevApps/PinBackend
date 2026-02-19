'use strict';

/**
 * Optional API key middleware.
 *
 * If the API_KEY environment variable is set, every request to protected
 * routes must include:
 *
 *   Authorization: Bearer <API_KEY>
 *
 * If API_KEY is not set, this middleware is a no-op.
 */
function apiKeyAuth(req, res, next) {
  const requiredKey = process.env.API_KEY;
  if (!requiredKey) return next(); // auth disabled

  const authHeader = req.headers['authorization'] || '';
  const [scheme, token] = authHeader.split(' ');

  if (scheme !== 'Bearer' || token !== requiredKey) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized. Provide a valid API key via "Authorization: Bearer <key>".',
    });
  }

  next();
}

module.exports = { apiKeyAuth };
