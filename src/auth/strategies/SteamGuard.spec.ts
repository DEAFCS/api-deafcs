import { SteamGuard } from "./SteamGuard";

// Adapted from 5stackgg/api b951af33 (#592). DEAFCS keeps its exact-origin
// rule for absolute URLs, so the subdomain cases upstream added later are not
// here.
// Reaching past `private` on purpose: this is the open-redirect guard, and the
// cases below are the reason it exists rather than an implementation detail.
const isSafeRedirect = (redirect: string, webDomain = "https://deafcs.net") =>
  (
    SteamGuard as unknown as {
      isSafeRedirect: (redirect: string, webDomain: string) => boolean;
    }
  ).isSafeRedirect(redirect, webDomain);

describe("SteamGuard.isSafeRedirect", () => {
  const dev = process.env.DEV;

  beforeEach(() => {
    delete process.env.DEV;
  });

  afterAll(() => {
    if (dev === undefined) {
      delete process.env.DEV;
    } else {
      process.env.DEV = dev;
    }
  });

  it("allows a relative path", () => {
    expect(isSafeRedirect("/matches/abc/camera")).toBe(true);
  });

  it("refuses a protocol-relative path, which is not local at all", () => {
    expect(isSafeRedirect("//evil.com/x")).toBe(false);
  });

  // Browsers read a backslash as a slash and drop tabs and newlines, so these
  // all leave for evil.com despite starting with a single "/".
  it("refuses paths a browser turns into another host", () => {
    expect(isSafeRedirect("/\\evil.com")).toBe(false);
    expect(isSafeRedirect("/\\/evil.com")).toBe(false);
    expect(isSafeRedirect("/\t/evil.com")).toBe(false);
    expect(isSafeRedirect("/\n/evil.com")).toBe(false);
  });

  it("still allows a relative path with a query and a hash", () => {
    expect(isSafeRedirect("/settings/linked-accounts?tab=twitch#top")).toBe(
      true,
    );
  });

  it("allows the panel's own origin", () => {
    expect(isSafeRedirect("https://deafcs.net/login")).toBe(true);
  });

  it("refuses another host", () => {
    expect(isSafeRedirect("https://evil.com/login")).toBe(false);
    expect(isSafeRedirect("https://deafcs.net.evil.com/")).toBe(false);
  });

  it("refuses something that is not a URL", () => {
    expect(isSafeRedirect("not a url")).toBe(false);
  });
});
