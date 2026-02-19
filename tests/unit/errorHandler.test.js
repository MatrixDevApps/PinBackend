'use strict';

/**
 * Unit tests — error handler middleware
 * Run: node --test tests/unit/errorHandler.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { errorHandler } = require('../../src/middleware/errorHandler');

// ---------------------------------------------------------------------------
// Helpers — lightweight mock req / res
// ---------------------------------------------------------------------------

function mockReq(overrides = {}) {
  return { path: '/api/extract', method: 'POST', ...overrides };
}

function mockRes() {
  const res = {
    _status: null,
    _body: null,
    status(code) { this._status = code; return this; },
    json(body)   { this._body = body;   return this; },
  };
  return res;
}

// Make a fake Axios-style HTTP error
function axiosError(statusCode) {
  const err = new Error(`Request failed with status ${statusCode}`);
  err.response = { status: statusCode, data: {} };
  return err;
}

// Make a network-level error (no .response)
function networkError(code) {
  const err = new Error(`Network error: ${code}`);
  err.code = code;
  return err;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('errorHandler — Axios HTTP errors', () => {
  it('maps 404 → HTTP 404 with success:false', () => {
    const res = mockRes();
    errorHandler(axiosError(404), mockReq(), res, () => {});
    assert.equal(res._status, 404);
    assert.equal(res._body.success, false);
    assert.ok(res._body.error);
  });

  it('maps 403 → HTTP 403', () => {
    const res = mockRes();
    errorHandler(axiosError(403), mockReq(), res, () => {});
    assert.equal(res._status, 403);
    assert.equal(res._body.success, false);
  });

  it('maps 401 → HTTP 403', () => {
    const res = mockRes();
    errorHandler(axiosError(401), mockReq(), res, () => {});
    assert.equal(res._status, 403);
  });

  it('maps 429 (Pinterest rate-limit) → HTTP 429', () => {
    const res = mockRes();
    errorHandler(axiosError(429), mockReq(), res, () => {});
    assert.equal(res._status, 429);
  });

  it('maps unexpected 5xx → HTTP 502', () => {
    const res = mockRes();
    errorHandler(axiosError(500), mockReq(), res, () => {});
    assert.equal(res._status, 502);
  });
});

describe('errorHandler — network errors', () => {
  it('ECONNABORTED → HTTP 504', () => {
    const res = mockRes();
    errorHandler(networkError('ECONNABORTED'), mockReq(), res, () => {});
    assert.equal(res._status, 504);
    assert.equal(res._body.success, false);
  });

  it('ETIMEDOUT → HTTP 504', () => {
    const res = mockRes();
    errorHandler(networkError('ETIMEDOUT'), mockReq(), res, () => {});
    assert.equal(res._status, 504);
  });

  it('ENOTFOUND → HTTP 502', () => {
    const res = mockRes();
    errorHandler(networkError('ENOTFOUND'), mockReq(), res, () => {});
    assert.equal(res._status, 502);
  });

  it('EAI_AGAIN → HTTP 502', () => {
    const res = mockRes();
    errorHandler(networkError('EAI_AGAIN'), mockReq(), res, () => {});
    assert.equal(res._status, 502);
  });
});

describe('errorHandler — app-level errors with statusCode', () => {
  it('respects err.statusCode 422', () => {
    const err = Object.assign(new Error('Cannot extract media'), { statusCode: 422 });
    const res = mockRes();
    errorHandler(err, mockReq(), res, () => {});
    assert.equal(res._status, 422);
    assert.equal(res._body.success, false);
    assert.equal(res._body.error, 'Cannot extract media');
  });

  it('respects err.statusCode 400', () => {
    const err = Object.assign(new Error('Bad input'), { statusCode: 400 });
    const res = mockRes();
    errorHandler(err, mockReq(), res, () => {});
    assert.equal(res._status, 400);
  });
});

describe('errorHandler — generic / unknown errors', () => {
  it('unknown error → HTTP 500 with success:false', () => {
    const res = mockRes();
    errorHandler(new Error('Something exploded'), mockReq(), res, () => {});
    assert.equal(res._status, 500);
    assert.equal(res._body.success, false);
  });

  it('response body never exposes stack trace in production', () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const res = mockRes();
    errorHandler(new Error('Internal failure'), mockReq(), res, () => {});
    assert.equal(res._body.detail, undefined);
    process.env.NODE_ENV = original;
  });
});
