FROM node:22-alpine

WORKDIR /app

# Install Chromium and dependencies
RUN apk add --no-cache \
    chromium \
    ffmpeg \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    dumb-init

# Set environment variables
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser \
    PUPPETEER_DISABLE_DEV_SHM_USAGE=true


COPY package*.json tsconfig.json ./

RUN npm ci

COPY . .

RUN npm run build

ENTRYPOINT ["node", "dist/main.js"]