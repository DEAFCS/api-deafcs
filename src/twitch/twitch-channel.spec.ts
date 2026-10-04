import { normalizeTwitchChannel, twitchChannelUrl } from "./twitch-channel";

describe("normalizeTwitchChannel", () => {
  it.each([
    ["tricoN", "tricon"],
    ["TRICON", "tricon"],
    ["  tricon  ", "tricon"],
    ["@TricoN", "tricon"],
    ["twitch.tv/tricon", "tricon"],
    ["https://twitch.tv/tricon", "tricon"],
    ["https://www.twitch.tv/tricon/", "tricon"],
    ["http://www.twitch.tv/TricoN", "tricon"],
    ["https://m.twitch.tv/tricon", "tricon"],
    ["https://www.twitch.tv/tricon?referrer=raid", "tricon"],
    ["deaf_cs_2025", "deaf_cs_2025"],
  ])("accepts %j as %j", (input, channel) => {
    expect(normalizeTwitchChannel(input)).toEqual({ ok: true, channel });
  });

  it.each([null, undefined, "", "   "])("clears on %j", (input) => {
    expect(normalizeTwitchChannel(input as any)).toEqual({ ok: true, channel: null });
  });

  it.each([
    ["https://clips.twitch.tv/SomeClipSlug", "unsupported_url"],
    ["https://www.twitch.tv/tricon/clip/SomeClipSlug", "unsupported_url"],
    ["https://www.twitch.tv/videos/123456789", "unsupported_url"],
    ["https://www.twitch.tv/tricon/videos", "unsupported_url"],
    ["https://www.twitch.tv/directory/category/counter-strike", "unsupported_url"],
    ["https://www.twitch.tv/", "unsupported_url"],
    ["https://youtube.com/@tricon", "unsupported_url"],
    ["https://twitch.tv.evil.com/tricon", "unsupported_url"],
    ["javascript:alert(1)", "invalid_url"],
    ["ftp://twitch.tv/tricon", "invalid_url"],
    ["http://", "invalid_url"],
    ["abc", "invalid_channel"],
    ["a".repeat(26), "invalid_channel"],
    ["tri con", "invalid_channel"],
    ["tri-con", "invalid_channel"],
    ["<script>", "invalid_channel"],
  ])("rejects %j (%s)", (input, error) => {
    expect(normalizeTwitchChannel(input)).toEqual({ ok: false, error });
  });

  it("builds the channel URL from the normalized login", () => {
    expect(twitchChannelUrl("tricon")).toBe("https://www.twitch.tv/tricon");
  });
});
