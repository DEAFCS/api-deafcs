# Headless-browser WHEP-to-JPEG snapshotter for match_options.streamer_camera_enabled.
# See server.js for the why. Deliberately its own image, its own deploy
# cycle -- nothing to do with api-deafcs's own build beyond living in
# the same repo for convenience. See DEAFCS/deafcs-web#91.
#
# Build (from repo root):
#   docker build -t ghcr.io/deafcs/streamer-camera-snapshotter:latest snapshotter/
FROM mcr.microsoft.com/playwright:v1.47.0-jammy

WORKDIR /app
COPY package.json .
RUN npm install --omit=dev
COPY server.js snapshot.html .

# Playwright's own image already has Chromium + all system deps
# installed and matched to this exact playwright npm version -- no
# `npx playwright install` needed.
EXPOSE 8080
CMD ["node", "server.js"]
