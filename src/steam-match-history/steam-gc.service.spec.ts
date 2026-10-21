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

const fakeRefreshToken = () => {
  const part = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  return [
    part({ typ: "JWT", alg: "EdDSA" }),
    part({
      iss: "steam",
      sub: BOT_STEAM_ID,
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

const gcService = (cached: string) =>
  new SteamGcService(
    { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as never,
    {
      get: jest.fn((key: string) =>
        key === "steam.steamUser" ? "deafcs-bot" : "password",
      ),
    } as never,
    { get: jest.fn(async () => cached), put: jest.fn() } as never,
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

  it("logs in with its own logon id when using STEAM_USER credentials", async () => {
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
