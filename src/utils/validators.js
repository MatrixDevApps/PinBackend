'use strict';

/**
 * Accepted Pinterest URL patterns:
 *  - https://pinterest.com/pin/123456/
 *  - https://www.pinterest.com/pin/123456/
 *  - https://pinterest.co.uk/pin/123456/   (and other country TLDs)
 *  - https://pin.it/AbCdEfG               (short links)
 */
const PINTEREST_PATTERNS = [
  // Full pin URLs — numeric or slug IDs
  /^https?:\/\/(www\.)?pinterest(\.[a-z]{2,3}){1,2}\/pin\/[a-zA-Z0-9_-]+\/?(\?.*)?$/,
  // Short links
  /^https?:\/\/pin\.it\/[a-zA-Z0-9_-]+\/?(\?.*)?$/,
];

/**
 * Validates that the provided value is a supported Pinterest URL.
 * Returns { valid: true, url: <trimmed url> } or { valid: false, error: <message> }.
 */
function validatePinterestUrl(url) {
  if (!url || typeof url !== 'string') {
    return { valid: false, error: 'Field "url" is required and must be a string.' };
  }

  const trimmed = url.trim();

  if (trimmed.length > 2048) {
    return { valid: false, error: 'URL exceeds maximum length of 2048 characters.' };
  }

  const matched = PINTEREST_PATTERNS.some((pattern) => pattern.test(trimmed));

  if (!matched) {
    return {
      valid: false,
      error:
        'Invalid Pinterest URL. Supported formats:\n' +
        '  • https://pinterest.com/pin/<id>/\n' +
        '  • https://www.pinterest.com/pin/<id>/\n' +
        '  • https://pin.it/<shortcode>',
    };
  }

  return { valid: true, url: trimmed };
}

module.exports = { validatePinterestUrl };
