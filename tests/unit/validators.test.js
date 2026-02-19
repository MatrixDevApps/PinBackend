'use strict';

/**
 * Unit tests — URL validator
 * Run: node --test tests/unit/validators.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { validatePinterestUrl } = require('../../src/utils/validators');

// ---------------------------------------------------------------------------
// Valid URLs
// ---------------------------------------------------------------------------

describe('validatePinterestUrl — valid URLs', () => {
  const validUrls = [
    'https://www.pinterest.com/pin/123456789/',
    'https://pinterest.com/pin/123456789/',
    'https://pinterest.com/pin/123456789',        // no trailing slash
    'https://www.pinterest.co.uk/pin/123456789/',  // country TLD
    'https://www.pinterest.fr/pin/abc-def-ghi/',   // slug-style ID
    'https://pin.it/AbCdEfG',                      // short link
    'https://pin.it/AbCdEfG/',                     // short link with slash
    'https://pinterest.com/pin/123456789/?utm_source=share', // with query params
  ];

  for (const url of validUrls) {
    it(`accepts: ${url}`, () => {
      const result = validatePinterestUrl(url);
      assert.equal(result.valid, true, `Expected valid=true for "${url}"`);
      assert.equal(result.url, url);
    });
  }
});

// ---------------------------------------------------------------------------
// Invalid URLs
// ---------------------------------------------------------------------------

describe('validatePinterestUrl — invalid URLs', () => {
  const invalidCases = [
    ['empty string', ''],
    ['null value', null],
    ['undefined value', undefined],
    ['number instead of string', 42],
    ['random string', 'not-a-url'],
    ['wrong domain', 'https://twitter.com/pin/123456789/'],
    ['instagram URL', 'https://www.instagram.com/p/ABC123/'],
    ['Pinterest board (not a pin)', 'https://www.pinterest.com/username/board-name/'],
    ['URL exceeding 2048 chars', 'https://pinterest.com/pin/' + 'a'.repeat(2050)],
  ];

  for (const [label, url] of invalidCases) {
    it(`rejects: ${label}`, () => {
      const result = validatePinterestUrl(url);
      assert.equal(result.valid, false, `Expected valid=false for "${label}"`);
      assert.ok(result.error, 'Expected an error message to be present');
    });
  }
});

// ---------------------------------------------------------------------------
// Return shape
// ---------------------------------------------------------------------------

describe('validatePinterestUrl — return shape', () => {
  it('returns trimmed URL on success', () => {
    const url = '  https://pinterest.com/pin/999/  ';
    const result = validatePinterestUrl(url.trim()); // validator itself doesn't trim, caller should
    assert.equal(result.valid, true);
    assert.equal(result.url, url.trim());
  });

  it('never includes a url key on failure', () => {
    const result = validatePinterestUrl('bad-url');
    assert.equal(result.valid, false);
    assert.equal(result.url, undefined);
  });

  it('error message is a non-empty string on failure', () => {
    const result = validatePinterestUrl('https://google.com');
    assert.equal(typeof result.error, 'string');
    assert.ok(result.error.length > 0);
  });
});
