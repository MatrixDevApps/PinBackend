'use strict';

/**
 * Integration tests — live Express server
 *
 * The server is started on an OS-assigned ephemeral port (listen(0)) so these
 * tests never conflict with a running dev server.
 *
 * Run: node --test tests/integration/api.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const app = require('../../src/server');

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let server;
let BASE;

before(() => {
  return new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      BASE = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(() => {
  return new Promise((resolve) => server.close(resolve));
});

// ---------------------------------------------------------------------------
// Tiny HTTP helper (no extra deps — uses Node's built-in http module)
// ---------------------------------------------------------------------------

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const url = new URL(path, BASE);

    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, headers: res.headers, body: data });
        }
      });
    });

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const get  = (path)       => request('GET',  path, null);
const post = (path, body) => request('POST', path, body);

// ---------------------------------------------------------------------------
// Health endpoint
// ---------------------------------------------------------------------------

describe('GET /health', () => {
  it('returns 200 with status:ok', async () => {
    const res = await get('/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
  });

  it('includes an ISO timestamp', async () => {
    const res = await get('/health');
    assert.ok(res.body.timestamp, 'timestamp field missing');
    assert.ok(!isNaN(Date.parse(res.body.timestamp)), 'timestamp is not a valid date');
  });
});

// ---------------------------------------------------------------------------
// Unknown routes
// ---------------------------------------------------------------------------

describe('404 catch-all', () => {
  it('GET /unknown → 404 with success:false', async () => {
    const res = await get('/unknown-route');
    assert.equal(res.status, 404);
    assert.equal(res.body.success, false);
    assert.ok(res.body.error);
  });

  it('GET /api → 404', async () => {
    const res = await get('/api');
    assert.equal(res.status, 404);
  });
});

// ---------------------------------------------------------------------------
// POST /api/extract — input validation (no network calls to Pinterest)
// ---------------------------------------------------------------------------

describe('POST /api/extract — request validation', () => {
  it('missing body → 400', async () => {
    const res = await post('/api/extract', {});
    assert.equal(res.status, 400);
    assert.equal(res.body.success, false);
    assert.ok(res.body.error);
  });

  it('null url → 400', async () => {
    const res = await post('/api/extract', { url: null });
    assert.equal(res.status, 400);
    assert.equal(res.body.success, false);
  });

  it('empty string url → 400', async () => {
    const res = await post('/api/extract', { url: '' });
    assert.equal(res.status, 400);
    assert.equal(res.body.success, false);
  });

  it('non-Pinterest URL → 400', async () => {
    const res = await post('/api/extract', { url: 'https://google.com' });
    assert.equal(res.status, 400);
    assert.equal(res.body.success, false);
  });

  it('Instagram URL → 400', async () => {
    const res = await post('/api/extract', { url: 'https://www.instagram.com/p/ABC123/' });
    assert.equal(res.status, 400);
    assert.equal(res.body.success, false);
  });

  it('plain text → 400', async () => {
    const res = await post('/api/extract', { url: 'just some text' });
    assert.equal(res.status, 400);
    assert.equal(res.body.success, false);
  });

  it('error body always has string error field', async () => {
    const res = await post('/api/extract', { url: 'bad' });
    assert.equal(typeof res.body.error, 'string');
    assert.ok(res.body.error.length > 0);
  });
});

// ---------------------------------------------------------------------------
// POST /api/extract — valid URL format (triggers Pinterest fetch)
// We don't assert success because the pin may be unavailable, but we assert
// that the server handles it gracefully (no 500, correct JSON shape).
// ---------------------------------------------------------------------------

describe('POST /api/extract — valid URL format (graceful handling)', () => {
  it('valid pin URL gets past validation and returns a JSON body', async () => {
    // This will try to fetch Pinterest — may succeed or fail with a meaningful
    // error depending on network/pin availability, but MUST NOT crash (500)
    const res = await post('/api/extract', {
      url: 'https://www.pinterest.com/pin/1/',
    });

    // Should never be a raw server crash
    assert.notEqual(res.status, 500);

    // Body must always be JSON with a success field
    assert.equal(typeof res.body, 'object');
    assert.equal(typeof res.body.success, 'boolean');

    // On failure, must have an error message
    if (!res.body.success) {
      assert.ok(res.body.error, 'Error response must include an error message');
    }
  });
});

// ---------------------------------------------------------------------------
// Rate limiting — 30 req/min window
// ---------------------------------------------------------------------------

describe('Rate limiter', () => {
  it('exposes RateLimit headers on the first request', async () => {
    const res = await post('/api/extract', { url: '' }); // 400 fast path, no Pinterest call
    // express-rate-limit v7 uses draft-7 header names
    const hasRateHeader =
      'ratelimit-limit' in res.headers ||
      'x-ratelimit-limit' in res.headers ||
      'ratelimit' in res.headers;
    assert.ok(hasRateHeader, 'Expected rate-limit response headers to be present');
  });

  it('returns 429 after exceeding 30 requests in the window', async () => {
    // Fire 31 rapid invalid requests (400 fast-path — no network calls)
    const requests = Array.from({ length: 31 }, () =>
      post('/api/extract', { url: '' }),
    );
    const results = await Promise.all(requests);
    const statuses = results.map((r) => r.status);

    const has429 = statuses.includes(429);
    assert.ok(has429, `Expected at least one 429 among statuses: ${statuses.join(', ')}`);

    // 429 body must be success:false
    const limited = results.find((r) => r.status === 429);
    assert.equal(limited.body.success, false);
    assert.ok(limited.body.error);
  });
});

// ---------------------------------------------------------------------------
// CORS headers
// ---------------------------------------------------------------------------

describe('CORS', () => {
  it('health endpoint responds to OPTIONS preflight', (_, done) => {
    const url = new URL('/health', BASE);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'OPTIONS',
        headers: {
          Origin: 'http://localhost:5173',
          'Access-Control-Request-Method': 'GET',
        },
      },
      (res) => {
        // CORS middleware should not return 405 or 500
        assert.ok(res.statusCode < 500, `OPTIONS returned ${res.statusCode}`);
        done();
      },
    );
    req.on('error', done);
    req.end();
  });
});
