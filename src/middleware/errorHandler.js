'use strict';

/**
 * Centralized error-handling middleware.
 * Must be registered LAST (after all routes) with four parameters.
 *
 * Handles:
 *  - Axios HTTP errors (Pinterest fetch failures)
 *  - Network/timeout errors
 *  - Validation errors (statusCode 400/422)
 *  - Generic internal errors
 */
function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  const timestamp = new Date().toISOString();

  // Log to stdout in a structured format (works well with Railway / Render log drains)
  console.error(JSON.stringify({
    level: 'error',
    timestamp,
    path: req.path,
    method: req.method,
    message: err.message,
    code: err.code,
    stack: process.env.NODE_ENV !== 'production' ? err.stack : undefined,
  }));

  // --- Axios response errors (Pinterest returned a non-2xx) ---
  if (err.response) {
    const { status } = err.response;

    if (status === 404) {
      return res.status(404).json({
        success: false,
        error: 'Pinterest pin not found. The URL may be invalid or the pin may have been deleted.',
      });
    }
    if (status === 403 || status === 401) {
      return res.status(403).json({
        success: false,
        error: 'Access denied by Pinterest. The pin may be private.',
      });
    }
    if (status === 429) {
      return res.status(429).json({
        success: false,
        error: 'Pinterest is rate-limiting our requests. Please try again in a moment.',
      });
    }

    return res.status(502).json({
      success: false,
      error: `Pinterest returned an unexpected response (HTTP ${status}). Please try again.`,
    });
  }

  // --- Network / timeout errors ---
  if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
    return res.status(504).json({
      success: false,
      error: 'The request to Pinterest timed out. Please try again.',
    });
  }
  if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') {
    return res.status(502).json({
      success: false,
      error: 'DNS lookup failed. Cannot reach Pinterest — check the server\'s internet connection.',
    });
  }

  // --- Application errors with explicit status codes ---
  if (err.statusCode) {
    return res.status(err.statusCode).json({
      success: false,
      error: err.message,
    });
  }

  // --- Fallback: 500 Internal Server Error ---
  res.status(500).json({
    success: false,
    error: 'An unexpected error occurred. Please try again later.',
    ...(process.env.NODE_ENV !== 'production' && { detail: err.message }),
  });
}

module.exports = { errorHandler };
