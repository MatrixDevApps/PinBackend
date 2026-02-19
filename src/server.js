'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');

const { extractLimiter, browserLimiter } = require('./middleware/rateLimiter');
const { errorHandler } = require('./middleware/errorHandler');
const { apiKeyAuth } = require('./middleware/apiKey');
const extractRouter = require('./routes/extract');
const browserRouter = require('./routes/browser');

// ---------------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------------

const app = express();
const PORT = process.env.PORT || 3000;

// Trust the first proxy hop (required for correct IP detection on Railway/Render)
app.set('trust proxy', 1);

// ---------------------------------------------------------------------------
// Global middleware
// ---------------------------------------------------------------------------

// CORS — restrict origins in production via ALLOWED_ORIGINS env var
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
  : '*';

app.use(
  cors({
    origin: allowedOrigins,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }),
);

// Body parsing — limit to 10 KB to guard against oversized payloads
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * GET /health
 * Simple liveness check used by Railway/Render health probes.
 */
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * POST /api/extract
 * Fast static extraction (axios + cheerio). 30 req/min.
 */
app.use('/api/extract', extractLimiter, apiKeyAuth, extractRouter);

/**
 * POST /api/extract/browser
 * Headless Chromium extraction for video pins. 5 req/min.
 */
app.use('/api/extract/browser', browserLimiter, apiKeyAuth, browserRouter);

// 404 — catch-all for unknown routes
app.use((_req, res) => {
  res.status(404).json({ success: false, error: 'Endpoint not found.' });
});

// ---------------------------------------------------------------------------
// Error handling (must be last)
// ---------------------------------------------------------------------------

app.use(errorHandler);

// ---------------------------------------------------------------------------
// Start server (only when run directly, not when required by tests)
// ---------------------------------------------------------------------------

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Pinterest Downloader API listening on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
  });

  process.on('SIGTERM', () => {
    console.log('SIGTERM received — shutting down gracefully');
    process.exit(0);
  });
}

module.exports = app;
