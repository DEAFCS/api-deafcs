import SteamUser from "steam-user";
import { STEAM_GC_LOGON_ID, SteamGcService } from "./steam-gc.service";
import { SteamPresenceService } from "../steam-presence/steam-presence.service";

// DEAFCS: the GC bot and a Steam Presence (friends) account may be the same
// Steam account, logged in twice from this API. Steam ends the older session
// when a second one of the same account arrives from the same public IP with
// the same logonID (sent as obfuscated_private_ip), so the two must differ.
// These run the real steam-user logOn and read the logon message it builds;
// only the network connection is stubbed.

const BOT_STEAM_ID = "76561198668284475";

const STREAMER_STEAM_ID = "76561198669755049";

const fakeRefreshToken = (sub = BOT_STEAM_ID) => {
  const part = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  return [
    part({ typ: "JWT", alg: "EdDSA" }),
    part({
      iss: "steam",
      sub,
      aud: ["client", "web", "renew", "derive"],
      iat: now,
      exp: now + 3600,
    }),
    "signature",
  ].join(".");
};

const loggedOnWith = (client: SteamUser) =>
  (
    client as unknown as {
      _logOnDetails: {
        obfuscated_private_ip?: { v4: number };
        access_token?: string;
        account_name?: string;
      };
    }
  )._logOnDetails;

const newClient = () =>
  new SteamUser({ autoRelogin: false, dataDirectory: null });

// steam-user builds the logon message on the next tick.
const settle = () => new Promise((resolve) => setImmediate(resolve));

// STEAM_USER / STEAM_PASSWORD are the livestream (DEAFCS Streamer) account.
const STREAMER_CONFIG = {
  "steam.steamUser": "deafcs-streamer",
  "steam.steamPassword": "streamer-password",
};
const GC_CONFIG = {
  ...STREAMER_CONFIG,
  "steam.steamGcSteamId64": BOT_STEAM_ID,
  "steam.steamGcUser": "deafcs-bot",
  "steam.steamGcPassword": "password",
};

const gcService = (
  cached: string,
  config: Record<string, string> = GC_CONFIG,
  cache = { get: jest.fn(async () => cached), put: jest.fn() },
) =>
  new SteamGcService(
    { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as never,
    { get: jest.fn((key: string) => config[key]) } as never,
    cache as never,
  );

const presenceLogOn = async (client: SteamUser, cached: string) => {
  const service = new SteamPresenceService(
    { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as never,
    { get: jest.fn(() => ({})) } as never,
    { get: jest.fn(async () => cached), put: jest.fn() } as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const account = { id: "friends-1", username: "deafcs-bot", password: "x" };
  (service as unknown as { clients: Map<string, SteamUser> }).clients.set(
    account.id,
    client,
  );
  await (
    service as unknown as {
      logOn: (client: SteamUser, account: object) => Promise<void>;
    }
  ).logOn(client, account);
};

describe("SteamGcService logon id", () => {
  beforeEach(() => {
    jest
      .spyOn(
        SteamUser.prototype as unknown as { _doConnection: () => void },
        "_doConnection",
      )
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("is a non-zero id that steam-user sends unchanged", () => {
    expect(STEAM_GC_LOGON_ID).not.toBe(0);
    expect(Number.isInteger(STEAM_GC_LOGON_ID)).toBe(true);
    expect(STEAM_GC_LOGON_ID).toBeLessThanOrEqual(2 ** 32 - 1);
  });

  it("logs in with its own logon id when using the stored refresh token", async () => {
    const client = newClient();
    await gcService(fakeRefreshToken())["logOn"](client);
    await settle();

    expect(loggedOnWith(client).access_token).toBeDefined();
    expect(loggedOnWith(client).obfuscated_private_ip).toEqual({
      v4: STEAM_GC_LOGON_ID,
    });
  });

  it("logs in with its own logon id when using STEAM_GC_USER credentials", async () => {
    const client = newClient();
    await gcService("")["logOn"](client);
    await settle();

    expect(loggedOnWith(client).account_name).toBe("deafcs-bot");
    expect(loggedOnWith(client).obfuscated_private_ip).toEqual({
      v4: STEAM_GC_LOGON_ID,
    });
  });

  it("does not share a logon id with a Steam Presence session of the same account", async () => {
    const token = fakeRefreshToken();
    const gc = newClient();
    const presence = newClient();

    await gcService(token)["logOn"](gc);
    await presenceLogOn(presence, token);
    await settle();

    // Same account, same token ...
    expect(loggedOnWith(gc).access_token).toBe(
      loggedOnWith(presence).access_token,
    );
    // ... but different logon ids, so neither replaces the other.
    expect(loggedOnWith(presence).obfuscated_private_ip).toEqual({ v4: 0 });
    expect(loggedOnWith(gc).obfuscated_private_ip?.v4).not.toBe(
      loggedOnWith(presence).obfuscated_private_ip?.v4,
    );
  });
});

describe("SteamGcService account", () => {
  beforeEach(() => {
    // connect() arms a 30 s GC-ready timeout; keep it from outliving the test.
    jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick"] });
    jest
      .spyOn(
        SteamUser.prototype as unknown as { _doConnection: () => void },
        "_doConnection",
      )
      .mockImplementation(() => undefined);
    jest
      .spyOn(SteamUser.prototype, "logOff")
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("is disabled without STEAM_GC_STEAMID64, even when STEAM_USER is set", () => {
    expect(gcService("", STREAMER_CONFIG).isAvailable()).toBe(false);
    expect(gcService("", GC_CONFIG).isAvailable()).toBe(true);
  });

  it("refuses to log in without STEAM_GC_STEAMID64", async () => {
    const client = newClient();

    await expect(
      gcService(fakeRefreshToken(), STREAMER_CONFIG)["logOn"](client),
    ).rejects.toThrow("STEAM_GC_STEAMID64 not configured");
    await settle();

    expect(loggedOnWith(client)).toBeUndefined();
  });

  it("never falls back to STEAM_USER when there is no stored token", async () => {
    const client = newClient();
    const service = gcService("", {
      ...STREAMER_CONFIG,
      "steam.steamGcSteamId64": BOT_STEAM_ID,
    });

    await expect(service["logOn"](client)).rejects.toThrow(
      "STEAM_GC_USER / STEAM_GC_PASSWORD not configured",
    );
    await settle();

    expect(loggedOnWith(client)).toBeUndefined();
  });

  it("ignores a stored token of another account and uses STEAM_GC_USER", async () => {
    const client = newClient();
    await gcService(fakeRefreshToken(STREAMER_STEAM_ID))["logOn"](client);
    await settle();

    expect(loggedOnWith(client).access_token).toBeUndefined();
    expect(loggedOnWith(client).account_name).toBe("deafcs-bot");
  });

  it("does not log in with a stored token of another account and no GC password", async () => {
    const client = newClient();
    const service = gcService(fakeRefreshToken(STREAMER_STEAM_ID), {
      ...STREAMER_CONFIG,
      "steam.steamGcSteamId64": BOT_STEAM_ID,
    });

    await expect(service["logOn"](client)).rejects.toThrow(
      "no stored refresh token for STEAM_GC_STEAMID64",
    );
    await settle();

    expect(loggedOnWith(client)).toBeUndefined();
  });

  it("only stores refresh tokens of the GC account", async () => {
    const cache = { get: jest.fn(async () => ""), put: jest.fn() };
    const service = gcService("", GC_CONFIG, cache);
    service["connect"]().catch(() => undefined);
    await settle();
    const client = service["client"] as SteamUser;

    client.emit("refreshToken", fakeRefreshToken(STREAMER_STEAM_ID));
    client.emit("refreshToken", "not-a-jwt");
    expect(cache.put).not.toHaveBeenCalled();

    const token = fakeRefreshToken();
    client.emit("refreshToken", token);
    expect(cache.put).toHaveBeenCalledWith("steam-gc:refresh-token", token);

    service["teardown"]();
  });

  it("logs off when Steam logs it on as another account", async () => {
    const service = gcService(fakeRefreshToken());
    // Only the loggedOn check is under test here; the logon itself is above.
    jest
      .spyOn(service as unknown as { logOn: () => Promise<void> }, "logOn")
      .mockResolvedValue(undefined);
    const rejected = expect(service["connect"]()).rejects.toThrow(
      "logged on as the wrong steam account",
    );
    await settle();
    const client = service["client"] as SteamUser;
    const logOff = jest.mocked(client.logOff);

    (client as unknown as { steamID: object }).steamID = {
      getSteamID64: () => STREAMER_STEAM_ID,
    };
    client.emit("loggedOn");

    await rejected;
    expect(logOff).toHaveBeenCalled();
    expect(service["client"]).toBeUndefined();
    expect(service.isReady()).toBe(false);
  });
});
