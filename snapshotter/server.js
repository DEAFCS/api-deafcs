// Headless-browser WHEP consumer for match_options.streamer_camera_enabled.
// See package.json / snapshot.html for the why. Runs as its own small
// deployment, entirely separate from api-deafcs's own image/deploy
// cycle -- ClusterIP-internal only (never exposed publicly), reachable
// only from game-streamer's spec-server. See DEAFCS/deafcs-web#91.

const express = require("express");
const { chromium } = require("playwright");
const path = require("path");

const PORT = process.env.PORT || 8080;
const MEDIAMTX_CAMERA_HOST = process.env.MEDIAMTX_CAMERA_HOST || "mediamtx-camera";
const MEDIAMTX_CAMERA_WHIP_PORT = process.env.MEDIAMTX_CAMERA_WHIP_PORT || "8891";
// How long an (matchId, steamId) session's browser page stays alive with
// no snapshot requests before it's torn down. Kept short -- a spectated
// player changes constantly, and an idle headless page still holds a
// real WebRTC connection open on mediamtx-camera's side.
const IDLE_TIMEOUT_MS = 20_000;
// A session that's still being polled (spectated player hasn't changed)
// but has NEVER produced a frame -- camera never published, path
// genuinely doesn't exist, connection quietly stuck -- would otherwise
// hold a Playwright page + an open RTCPeerConnection open forever,
// since every poll resets IDLE_TIMEOUT_MS's clock regardless of whether
// anything is actually working. This caps how long a session gets to
// stay open with zero frames before a fresh attempt replaces it.
const NEVER_CONNECTED_TIMEOUT_MS = 15_000;
const REAP_INTERVAL_MS = 5_000;
const SCREENSHOT_TIMEOUT_MS = 3_000;
const VALID_STEAM_ID = /^\d{17}$/;
const VALID_MATCH_ID = /^[0-9a-f-]{36}$/i;

const app = express();
let browser;
/** @type {Map<string, { page: import("playwright").Page, lastAccess: number, createdAt: number }>} */
const sessions = new Map();

async function getSession(matchId, steamId) {
  const key = `${matchId}:${steamId}`;
  const existing = sessions.get(key);
  if (existing) {
    existing.lastAccess = Date.now();
    return existing;
  }

  const streamPath = `stream-cam-${matchId}-${steamId}`;
  const whepUrl = `http://${MEDIAMTX_CAMERA_HOST}:${MEDIAMTX_CAMERA_WHIP_PORT}/${streamPath}/whep`;
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  // Diagnostic logging, kept permanently -- forward the page's own
  // console + any uncaught error straight to this process's stdout,
  // which is what `kubectl logs` actually shows. This is how we found
  // the CORS issue below in the first place.
  page.on("console", (msg) => console.log(`[page:${key}] ${msg.type()}: ${msg.text()}`));
  page.on("pageerror", (err) => console.log(`[page:${key}] pageerror: ${err.message}`));
  page.on("requestfailed", (req) =>
    console.log(`[page:${key}] requestfailed: ${req.url()} ${req.failure()?.errorText}`),
  );
  await page.goto(`file://${path.join(__dirname, "snapshot.html")}`);

  // The page itself does NOT fetch() the WHEP endpoint -- a file://
  // page's origin is "null", and mediamtx-camera's CORS preflight
  // response never includes Access-Control-Allow-Origin (confirmed via
  // a direct curl OPTIONS request), so the browser rejects the POST
  // before it's even sent. Node's fetch isn't subject to CORS at all,
  // so the negotiation is done here instead: get the offer SDP out of
  // the page, POST it ourselves, hand the answer back in. The actual
  // media/ICE/DTLS still happens directly between the page and
  // mediamtx-camera -- CORS only ever applied to this one signaling
  // request, never to the WebRTC transport itself.
  const offerSdp = await page.evaluate(() => window.__createOffer());
  const whepRes = await fetch(whepUrl, {
    method: "POST",
    headers: { "Content-Type": "application/sdp" },
    body: offerSdp,
  });
  if (!whepRes.ok) {
    await page.close().catch(() => {});
    throw new Error(`whep POST failed: ${whepRes.status}`);
  }
  const answerSdp = await whepRes.text();
  await page.evaluate((sdp) => window.__setAnswer(sdp), answerSdp);

  const now = Date.now();
  const session = { page, lastAccess: now, createdAt: now };
  sessions.set(key, session);
  return session;
}

async function closeSession(key) {
  const session = sessions.get(key);
  if (!session) return;
  sessions.delete(key);
  try {
    await session.page.close();
  } catch {
    /* best-effort */
  }
}

app.get("/snapshot/:matchId/:steamId", async (req, res) => {
  const { matchId, steamId } = req.params;
  if (!VALID_MATCH_ID.test(matchId) || !VALID_STEAM_ID.test(steamId)) {
    res.status(400).send("invalid matchId/steamId");
    return;
  }

  const key = `${matchId}:${steamId}`;
  try {
    const session = await getSession(matchId, steamId);
    // A <video> element with no track still screenshots fine (as a
    // plain black frame) -- __hasFrame (set by snapshot.html only once
    // a real track has actually decoded a frame) is what distinguishes
    // "connected and live" from "not connected yet/at all", the same
    // distinction the old WebRTC client made via ontrack before
    // revealing anything.
    const hasFrame = await session.page.evaluate(() => window.__hasFrame === true);
    if (!hasFrame) {
      res.status(404).send("no frame available");
      return;
    }
    const jpeg = await session.page
      .locator("#v")
      .screenshot({ type: "jpeg", quality: 70, timeout: SCREENSHOT_TIMEOUT_MS });
    res.set("Cache-Control", "no-store").type("image/jpeg").send(jpeg);
  } catch (error) {
    // Common/expected case (feature off, player hasn't published yet,
    // still negotiating) -- not worth logging every poll cycle.
    res.status(404).send("no frame available");
    // A session that's been failing outright (connect() itself threw,
    // not just "no frame yet") is unlikely to recover on its own --
    // drop it so the next request starts a clean attempt instead of
    // screenshotting a permanently-blank video element for 20s.
    const session = sessions.get(key);
    if (session) {
      const err = await session.page
        .evaluate(() => window.__snapshotError || null)
        .catch(() => null);
      if (err) await closeSession(key);
    }
  }
});

app.get("/healthz", (_req, res) => res.send("ok"));

setInterval(async () => {
  const now = Date.now();
  for (const [key, session] of sessions) {
    if (now - session.lastAccess > IDLE_TIMEOUT_MS) {
      void closeSession(key);
      continue;
    }
    if (now - session.createdAt > NEVER_CONNECTED_TIMEOUT_MS) {
      const hasFrame = await session.page
        .evaluate(() => window.__hasFrame === true)
        .catch(() => false);
      if (!hasFrame) void closeSession(key);
    }
  }
}, REAP_INTERVAL_MS);

(async () => {
  browser = await chromium.launch({
    args: [
      "--no-sandbox",
      "--disable-gpu",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
  app.listen(PORT, () => {
    console.log(`[snapshotter] listening on :${PORT}`);
  });
})();

process.on("SIGTERM", async () => {
  await browser?.close().catch(() => {});
  process.exit(0);
});
