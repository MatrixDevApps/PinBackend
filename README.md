# Pinterest Downloader API

A lightweight REST API that extracts direct media URLs (video, image, GIF) from Pinterest pins. Built with Node.js + Express.

---

## Features

- Extracts MP4 videos at the highest available quality (up to 1080p)
- Extracts full-resolution images and GIFs
- Handles `pinterest.com/pin/…` and `pin.it/…` short links
- Rate limiting — 30 requests / minute per IP
- Optional API key authentication
- JSON error responses with meaningful HTTP status codes
- Health check endpoint for Railway / Render probes

---

## Quick Start

```bash
# 1. Clone / copy the project
cd pinterest-downloader-api

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
# Edit .env as needed

# 4. Start the server
npm run dev   # development (nodemon, auto-reload)
npm start     # production
```

The server listens on `http://localhost:3000` by default.

---

## API Reference

### `POST /api/extract`

Extract a media URL from a Pinterest pin.

**Request**

```http
POST /api/extract
Content-Type: application/json

{
  "url": "https://www.pinterest.com/pin/123456789/"
}
```

**Supported URL formats**

| Format | Example |
|--------|---------|
| Full pin URL | `https://pinterest.com/pin/123456789/` |
| With www | `https://www.pinterest.com/pin/123456789/` |
| Country TLD | `https://pinterest.co.uk/pin/123456789/` |
| Short link | `https://pin.it/AbCdEfG` |

**Success Response** `200 OK`

```json
{
  "success": true,
  "type": "video",
  "media_url": "https://v.pinimg.com/videos/mc/720p/ab/cd/ef/abcdef.mp4",
  "thumbnail": "https://i.pinimg.com/originals/ab/cd/ef/abcdef.jpg",
  "title": "Amazing sunset timelapse"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `success` | boolean | Always `true` on success |
| `type` | string | `"video"`, `"image"`, or `"gif"` |
| `media_url` | string | Direct URL to the media file |
| `thumbnail` | string \| null | Preview image URL |
| `title` | string | Pin title / description |

**Error Responses**

| Status | Cause |
|--------|-------|
| `400` | Missing or invalid URL format |
| `401` | API key missing or wrong (when `API_KEY` is set) |
| `403` | Pin is private or Pinterest denied access |
| `404` | Pin not found / deleted |
| `422` | Media could not be extracted (unsupported pin type) |
| `429` | Rate limit exceeded (30 req/min) |
| `504` | Pinterest fetch timed out |

All errors follow this shape:

```json
{
  "success": false,
  "error": "Human-readable error message."
}
```

---

### `GET /health`

Liveness probe — no auth required.

```json
{ "status": "ok", "timestamp": "2024-01-01T00:00:00.000Z" }
```

---

## Environment Variables

Copy `.env.example` to `.env` and edit:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Port the server binds to |
| `NODE_ENV` | `development` | Set to `production` for prod |
| `ALLOWED_ORIGINS` | `*` | Comma-separated CORS origins |
| `API_KEY` | _(empty)_ | Optional bearer token; leave empty to disable auth |

---

## Deployment

### Railway

1. Push your code to a GitHub repository.
2. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**.
3. Select your repository.
4. Railway auto-detects Node.js and runs `npm start`.
5. Add environment variables under **Settings → Variables**:
   ```
   NODE_ENV=production
   ALLOWED_ORIGINS=https://yourfrontend.com
   API_KEY=your-secret-key   # optional
   ```
6. Railway provides a public URL automatically — no extra config needed.

> **Health check:** Railway pings `/health` to verify the service is up.

---

### Render

1. Push to GitHub.
2. Go to [render.com](https://render.com) → **New** → **Web Service**.
3. Connect your repository.
4. Set:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Environment:** `Node`
5. Add the same environment variables as above.
6. Enable the **Health Check Path** → `/health`.

---

### Docker (optional)

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 3000
CMD ["node", "src/server.js"]
```

```bash
docker build -t pinterest-api .
docker run -p 3000:3000 --env-file .env pinterest-api
```

---

## Project Structure

```
src/
├── server.js                  # Express app entry point
├── routes/
│   └── extract.js             # POST /api/extract route
├── middleware/
│   ├── apiKey.js              # Optional bearer-token auth
│   ├── errorHandler.js        # Centralized error handler
│   └── rateLimiter.js         # express-rate-limit config
└── utils/
    ├── pinterest.js           # Pinterest fetch + media extraction logic
    └── validators.js          # URL validation
```

---

## How It Works

1. **URL validation** — checks the URL matches a known Pinterest pattern.
2. **Short link resolution** — `pin.it/…` links are followed to get the full URL.
3. **Page fetch** — axios GETs the pin page with realistic browser headers to avoid bot-detection blocks.
4. **JSON extraction** — cheerio parses the HTML and finds the `__PWS_DATA__` / `__PWS_INITIAL_DATA__` script tag that Pinterest uses for server-side rendering.
5. **Media selection** — the extracted JSON is searched recursively for `video_list` (MP4 at the highest available quality) or `images` (full-resolution). If neither is found, OG meta tags are used as a fallback.
6. **Response** — the direct media URL, thumbnail, and title are returned as JSON.

---

## Notes & Limitations

- **Private pins** cannot be downloaded — Pinterest returns 403.
- Pinterest may change their page structure at any time, which can break extraction. If that happens, the OG meta tag fallback still provides a lower-quality URL.
- This API is intended for **personal / educational use**. Always respect Pinterest's [Terms of Service](https://policy.pinterest.com/en/terms-of-service) and creators' copyright.
