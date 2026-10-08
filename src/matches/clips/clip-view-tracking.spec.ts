import {
  clipViewerKey,
  createClipViewMeter,
  shouldTrackClipView,
} from "./clip-view-tracking";

const chrome =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36";

describe("shouldTrackClipView", () => {
  it("tracks an ordinary browser GET", () => {
    expect(shouldTrackClipView({ method: "GET", userAgent: chrome })).toBe(
      true,
    );
  });

  it.each([
    ["a download (dl=1)", { dl: "1" }],
    ["a download (download=1)", { download: "1" }],
    ["a preload (noview=1)", { noview: "1" }],
    ["a HEAD request", { method: "HEAD" }],
  ])("does not track %s", (_name, over) => {
    expect(
      shouldTrackClipView({ method: "GET", userAgent: chrome, ...over }),
    ).toBe(false);
  });

  it.each([
    "Googlebot/2.1 (+http://www.google.com/bot.html)",
    "Mozilla/5.0 (compatible; Discordbot/2.0)",
    "Slackbot-LinkExpanding 1.0",
    "facebookexternalhit/1.1",
    "WhatsApp/2.23",
    "Twitterbot preview",
  ])("does not track the bot %s", (userAgent) => {
    expect(shouldTrackClipView({ method: "GET", userAgent })).toBe(false);
  });

  it("treats a missing user agent as a normal viewer", () => {
    expect(shouldTrackClipView({ method: "GET" })).toBe(true);
  });
});

describe("clipViewerKey", () => {
  it("is a 32 character hex hash that carries no address", () => {
    const key = clipViewerKey("203.0.113.9", chrome);
    expect(key).toMatch(/^[a-f0-9]{32}$/);
    expect(key).not.toContain("203");
  });

  it("is stable per viewer and differs between viewers", () => {
    expect(clipViewerKey("203.0.113.9", chrome)).toBe(
      clipViewerKey("203.0.113.9", chrome),
    );
    expect(clipViewerKey("203.0.113.9", chrome)).not.toBe(
      clipViewerKey("203.0.113.10", chrome),
    );
    expect(clipViewerKey("203.0.113.9", chrome)).not.toBe(
      clipViewerKey("203.0.113.9", "Firefox"),
    );
  });
});

describe("createClipViewMeter", () => {
  it("fires once when delivery reaches the middle of the file", () => {
    const onQualified = jest.fn();
    const meter = createClipViewMeter(0, 1000, onQualified);
    meter.add(400);
    expect(onQualified).not.toHaveBeenCalled();
    meter.add(100);
    expect(onQualified).toHaveBeenCalledTimes(1);
    meter.add(500);
    expect(onQualified).toHaveBeenCalledTimes(1);
  });

  it("does not fire for a response that stops short of the middle", () => {
    const onQualified = jest.fn();
    const meter = createClipViewMeter(0, 1000, onQualified);
    meter.add(499);
    expect(onQualified).not.toHaveBeenCalled();
  });

  it("fires for a range that starts before and crosses the middle", () => {
    const onQualified = jest.fn();
    const meter = createClipViewMeter(400, 1000, onQualified);
    meter.add(50);
    expect(onQualified).not.toHaveBeenCalled();
    meter.add(50);
    expect(onQualified).toHaveBeenCalledTimes(1);
  });

  it("never fires for a tail seek or end-of-file probe", () => {
    const onQualified = jest.fn();
    const meter = createClipViewMeter(900, 1000, onQualified);
    meter.add(100);
    expect(onQualified).not.toHaveBeenCalled();
  });

  it("ignores an empty file", () => {
    const onQualified = jest.fn();
    createClipViewMeter(0, 0, onQualified).add(10);
    expect(onQualified).not.toHaveBeenCalled();
  });
});
