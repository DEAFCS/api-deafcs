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
// no snapshot/stream requests before it's torn down. Kept short -- a
// spectated player changes constantly, and an idle headless page still
// holds a real WebRTC connection open on mediamtx-camera's side.
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
/**
 * @type {Map<string, {
 *   page: import("playwright").Page,
 *   cdp: import("playwright").CDPSession | null,
 *   screencastActive: boolean,
 *   hasFrame: boolean,
 *   lastAccess: number,
 *   createdAt: number,
 *   streamRes: Set<import("express").Response>,
 * }>}
 */
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

  const now = Date.now();
  const session = {
    page,
    cdp: null,
    screencastActive: false,
    hasFrame: false,
    lastAccess: now,
    createdAt: now,
    streamRes: new Set(),
  };

  // Diagnostic logging, kept permanently -- forward the page's own
  // console + any uncaught error straight to this process's stdout,
  // which is what `kubectl logs` actually shows. This is how we found
  // the CORS issue below in the first place.
  page.on("console", (msg) => console.log(`[page:${key}] ${msg.type()}: ${msg.text()}`));
  page.on("pageerror", (err) => console.log(`[page:${key}] pageerror: ${err.message}`));
  page.on("requestfailed", (req) =>
    console.log(`[page:${key}] requestfailed: ${req.url()} ${req.failure()?.errorText}`),
  );

  // Called by snapshot.html the moment a real track has decoded its
  // first frame -- cheaper and more immediate than polling
  // window.__hasFrame from Node, and what gates both /snapshot and
  // /stream from serving a plain black frame (a <video> with no track
  // still renders/screenshots fine as one) before there's an actual
  // picture.
  await page.exposeFunction("deafcsFrameReady", () => {
    session.hasFrame = true;
  });

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
  let whepRes;
  try {
    // A codec-mismatch offer (e.g. this receiver can't decode what's
    // published -- see snapshot.html's getCapabilities log) sometimes
    // gets no response from mediamtx at all rather than a prompt error,
    // which without a timeout hung this fetch indefinitely -- the
    // session just sat there until NEVER_CONNECTED_TIMEOUT_MS reaped it
    // 15s later, silently, every single retry. Fail fast instead.
    whepRes = await fetch(whepUrl, {
      method: "POST",
      headers: { "Content-Type": "application/sdp" },
      body: offerSdp,
      signal: AbortSignal.timeout(5_000),
    });
  } catch (err) {
    await page.close().catch(() => {});
    throw new Error(`whep POST failed: ${err?.message ?? err}`);
  }
  if (!whepRes.ok) {
    await page.close().catch(() => {});
    throw new Error(`whep POST failed: ${whepRes.status}`);
  }
  const answerSdp = await whepRes.text();
  await page.evaluate((sdp) => window.__setAnswer(sdp), answerSdp);

  sessions.set(key, session);
  return session;
}

// Starts (if not already running) a CDP screencast for this session --
// Chromium pushes each newly-composited frame to us directly, which is
// far cheaper and far higher-framerate than the old approach of
// repeatedly calling locator().screenshot() in a timed loop (each call
// is a full round-trip; screencast is push-based). One screencast feeds
// every attached /stream client for this session, not one per viewer.
async function ensureScreencast(session) {
  if (session.screencastActive) return;
  session.screencastActive = true;

  if (!session.cdp) {
    session.cdp = await session.page.context().newCDPSession(session.page);
    session.cdp.on("Page.screencastFrame", (frame) => {
      void handleScreencastFrame(session, frame);
    });
  }

  await session.cdp.send("Page.startScreencast", {
    format: "jpeg",
    quality: 70,
    maxWidth: 640,
    maxHeight: 360,
    // Chromium's raw composited framerate here runs ~20fps -- way more
    // than a small avatar/corner cam needs, and more than the consumer
    // (the HUD's Electron overlay window, on a node also busy running
    // CS2 + GPU-encoding the main broadcast) could keep up with:
    // frames piled up faster than they rendered, then dumped in a
    // burst once the backlog cleared -- "smooth, then a ~3s stall,
    // repeat". Cutting the source rate directly (rather than just
    // reacting to backpressure below) means there's no backlog to
    // build up in the first place.
    everyNthFrame: 3,
  });
}

async function handleScreencastFrame(session, frame) {
  try {
    if (session.hasFrame && session.streamRes.size > 0) {
      const jpeg = Buffer.from(frame.data, "base64");
      const head = `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`;
      for (const res of session.streamRes) {
        if (res.writableEnded) continue;
        // res.write() returning false means Node's internal buffer for
        // this response is still full from a previous frame -- writing
        // more on top of it anyway is exactly how a backlog piles up
        // silently in memory and then dumps all at once. Drop this
        // frame for this client instead; the next one comes in well
        // under a second either way.
        if (res._deafcsBackpressured) continue;
        const ok = res.write(head) && res.write(jpeg) && res.write("\r\n");
        if (!ok) {
          res._deafcsBackpressured = true;
          res.once("drain", () => { res._deafcsBackpressured = false; });
        }
      }
      session.lastAccess = Date.now();
    }
  } finally {
    if (session.cdp) {
      await session.cdp
        .send("Page.screencastFrameAck", { sessionId: frame.sessionId })
        .catch(() => {});
    }
  }
}

async function stopScreencastIfIdle(session) {
  if (!session.screencastActive || session.streamRes.size > 0) return;
  session.screencastActive = false;
  try {
    await session.cdp?.send("Page.stopScreencast");
  } catch {
    /* best-effort */
  }
}

async function closeSession(key) {
  const session = sessions.get(key);
  if (!session) return;
  sessions.delete(key);
  // Any /stream clients still attached to this session would otherwise
  // be left hanging -- end them explicitly first.
  for (const res of session.streamRes) {
    try { res.end(); } catch { /* best-effort */ }
  }
  session.streamRes.clear();
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
    if (!session.hasFrame) {
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

// Continuous MJPEG stream (multipart/x-mixed-replace), so the HUD
// overlay window can just point a plain <img src=...> at this URL and
// get real, continuously-updating video with zero JS of its own --
// browsers have natively supported multipart JPEG streams in <img>
// since forever (it's how most IP/security cameras have always worked).
// Frames come from a CDP screencast (see ensureScreencast), not a
// polling loop -- pushed as Chromium renders them, not fetched on a
// timer, which is both simpler and gets meaningfully closer to a real
// framerate. Reuses the exact same session (and its already-negotiated
// WHEP connection) as /snapshot.
app.get("/stream/:matchId/:steamId", async (req, res) => {
  const { matchId, steamId } = req.params;
  if (!VALID_MATCH_ID.test(matchId) || !VALID_STEAM_ID.test(steamId)) {
    res.status(400).send("invalid matchId/steamId");
    return;
  }

  let session;
  try {
    session = await getSession(matchId, steamId);
  } catch (err) {
    console.log(`[stream:${matchId}:${steamId}] session failed: ${err?.message ?? err}`);
    res.status(404).send("no frame available");
    return;
  }

  res.writeHead(200, {
    "Content-Type": "multipart/x-mixed-replace; boundary=frame",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  });

  session.streamRes.add(res);
  session.lastAccess = Date.now();
  req.on("close", () => {
    session.streamRes.delete(res);
    void stopScreencastIfIdle(session);
  });

  try {
    await ensureScreencast(session);
  } catch {
    session.streamRes.delete(res);
    try { res.end(); } catch { /* best-effort */ }
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
    if (now - session.createdAt > NEVER_CONNECTED_TIMEOUT_MS && !session.hasFrame) {
      void closeSession(key);
    }
  }
}, REAP_INTERVAL_MS);

(async () => {
  browser = await chromium.launch({
    // Real Google Chrome, not Playwright's bundled open-source Chromium
    // build -- the bundled one lacks H.264 decode (licensing), which
    // silently breaks any publisher whose browser sends H.264 (iPhone
    // Safari's hardware encoder does, by default, with unreliable/no
    // VP8 fallback). See DEAFCS/deafcs-web#91 and this Dockerfile.
    channel: "chrome",
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
