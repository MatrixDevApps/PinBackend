FROM node:20-slim

WORKDIR /app

# Copy dependency manifests first for better layer caching
COPY package*.json ./

# Install Node dependencies.
# PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 prevents the postinstall script from
# downloading browsers here — we install them explicitly in the next step.
RUN PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --omit=dev

# Install Playwright's Chromium browser + all required OS dependencies.
# --with-deps handles the apt-get install of system libraries automatically.
RUN npx playwright install --with-deps chromium

# Copy application source
COPY . .

# Railway injects $PORT at runtime (default 3000 as fallback)
ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "src/server.js"]
