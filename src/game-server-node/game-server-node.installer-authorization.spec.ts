import { ForbiddenException } from "@nestjs/common";
import { randomBytes } from "crypto";
import { Request, Response } from "express";
import { GameServerNodeController } from "./game-server-node.controller";

function harness() {
  const token = randomBytes(24).toString("hex");
  let role: string | undefined = "administrator";
  let storedToken: string | null = token;
  const query = jest.fn(async (selection: any) =>
    selection.players_by_pk
      ? { players_by_pk: role ? { role } : null }
      : {
          game_server_nodes_by_pk: { token: storedToken },
          settings: [] as Array<{ name: string; value: string }>,
        },
  );
  const getAuthKey = jest.fn().mockResolvedValue(token);
  const create = jest.fn().mockResolvedValue({ id: "test-node", token });
  const controller = Object.assign(
    Object.create(GameServerNodeController.prototype),
    {
      hasura: { query },
      tailscale: { getAuthKey },
      gameServerNodeService: { create },
      appConfig: { apiDomain: "https://example.invalid" },
    },
  ) as GameServerNodeController;
  const response = { setHeader: jest.fn(), write: jest.fn(), end: jest.fn() };
  const download = (queryToken: unknown = token, user?: any) =>
    controller.script(
      {
        params: { gameServerNodeId: "test-node.sh" },
        query: { token: queryToken },
        user,
      } as unknown as Request,
      response as unknown as Response,
    );
  return {
    token,
    query,
    create,
    getAuthKey,
    response,
    download,
    controller,
    setRole: (value: string | undefined) => {
      role = value;
    },
    setToken: (value: string | null) => {
      storedToken = value;
    },
  };
}

describe("node installer authorization", () => {
  it.each([undefined, "", [], {}, ["unexpected"], "incorrect"])(
    "rejects a missing, malformed or incorrect token (case %#)",
    async (supplied) => {
      const h = harness();
      // Pass undefined through explicitly; the harness defaults to a valid token.
      const result =
        supplied === undefined
          ? h.controller.script(
              {
                params: { gameServerNodeId: "test-node.sh" },
                query: {},
              } as unknown as Request,
              h.response as unknown as Response,
            )
          : h.download(supplied);
      await expect(result).rejects.toBeInstanceOf(ForbiddenException);
      expect(h.response.write).not.toHaveBeenCalled();
    },
  );
  it("rejects equal character length with different UTF-8 byte lengths safely", async () => {
    const h = harness();
    h.setToken("aa");
    await expect(h.download("éé")).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.response.write).not.toHaveBeenCalled();
  });
  it.each([null, ""])(
    "rejects cleared or empty stored tokens (case %#)",
    async (stored) => {
      const h = harness();
      h.setToken(stored);
      await expect(h.download()).rejects.toBeInstanceOf(ForbiddenException);
      expect(h.response.write).not.toHaveBeenCalled();
    },
  );
  it("rejects an unknown node with the same generic error", async () => {
    const h = harness();
    h.query.mockResolvedValueOnce({
      game_server_nodes_by_pk: null,
      settings: [] as Array<{ name: string; value: string }>,
    });
    await expect(h.download()).rejects.toThrow(
      "Invalid installer authorization",
    );
    expect(h.response.write).not.toHaveBeenCalled();
  });
  it.each([
    "user",
    "verified_user",
    "moderator",
    "streamer",
    "match_organizer",
    "tournament_organizer",
  ])(
    "rejects a signed-in %s even holding a token or claiming admin",
    async (role) => {
      const h = harness();
      h.setRole(role);
      await expect(
        h.download(h.token, { steam_id: "caller", role: "administrator" }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(h.response.write).not.toHaveBeenCalled();
    },
  );
  it("preserves unattended curl with the exact administrator-issued bearer token", async () => {
    const h = harness();
    await h.download();
    expect(h.response.write).toHaveBeenCalledTimes(1);
    expect(h.response.setHeader).toHaveBeenCalledWith(
      "Cache-Control",
      "no-store",
    );
    // Compare booleans so generated tokens/script credentials cannot appear in a failing diff.
    expect(h.response.write.mock.calls[0][0].includes(h.token)).toBe(true);
  });
  it("allows an administrator with a valid token", async () => {
    const h = harness();
    await h.download(h.token, { steam_id: "caller", role: "user" });
    expect(h.response.write).toHaveBeenCalledTimes(1);
  });
  it("does not let an administrator bypass token validation", async () => {
    const h = harness();
    await expect(
      h.download("incorrect", { steam_id: "caller", role: "administrator" }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.response.write).not.toHaveBeenCalled();
  });
  it("rejects unauthenticated installer issuance before creating credentials", async () => {
    const h = harness();
    await expect(h.controller.setupGameServer()).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(h.getAuthKey).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
  });
  it.each([
    "user",
    "verified_user",
    "moderator",
    "streamer",
    "match_organizer",
    "tournament_organizer",
    undefined,
  ])(
    "rejects non-admin or deleted users issuing installers (case %#)",
    async (role) => {
      const h = harness();
      h.setRole(role);
      await expect(
        h.controller.setupGameServer({
          user: { steam_id: "caller", role: "administrator", name: "test" },
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(h.getAuthKey).not.toHaveBeenCalled();
      expect(h.create).not.toHaveBeenCalled();
    },
  );
  it("preserves the administrator-issued installation link and .sh token download", async () => {
    const h = harness();
    const result = await h.controller.setupGameServer({
      user: { steam_id: "caller", role: "administrator", name: "test" },
    });
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(result.link.includes("test-node.sh?token=" + h.token)).toBe(true);
    await h.download();
    expect(h.response.write).toHaveBeenCalledTimes(1);
  });
});
