import { Logger } from "@nestjs/common";
import Redis from "ioredis";
import { e_match_types_enum } from "generated";

import { MatchmakingLobbyService } from "./matchmaking-lobby.service";
import { HasuraService } from "../hasura/hasura.service";
import { MatchmakeService } from "./matchmake.service";
import { PlayerLobby } from "./types/PlayerLobby";
import { JoinQueueError } from "./utilities/joinQueueError";
import { User } from "../auth/types/User";
import { ExpectedPlayers } from "../discord-bot/enums/ExpectedPlayers";

/**
 * The party-size rule: a lobby may queue only when it fits in one lineup
 * (<= half the match); matchmaking fills the other side. A party filling
 * the whole match on its own used to be allowed as an "in-house" split, but
 * that let a group decide its own result (ELO farming), so it is rejected
 * for every type. Competitive is additionally capped by the admin setting
 * public.matchmaking_max_party_size_competitive (1-5, default 5).
 */
describe("MatchmakingLobbyService.verifyLobby", () => {
  let service: MatchmakingLobbyService;
  let mockHasura: jest.Mocked<HasuraService>;
  // Value of public.matchmaking_max_party_size_competitive; undefined = no row.
  let maxCompetitivePartySizeSetting: string | undefined;

  const captainSteamId = "steam-id-1";
  const captain = { steam_id: captainSteamId } as User;

  // Premier and Faceit are demo-import only — they are never matchmade.
  const matchmakingTypes: e_match_types_enum[] = [
    "Duel",
    "Wingman",
    "Competitive",
  ];

  const buildLobby = (playerCount: number): PlayerLobby => ({
    id: "lobby-1",
    players: Array.from({ length: playerCount }, (_, index) => ({
      captain: index === 0,
      name: `player-${index + 1}`,
      steam_id: index === 0 ? captainSteamId : `steam-id-${index + 1}`,
      is_banned: false,
      matchmaking_cooldown: false,
    })),
  });

  const canQueue = async (type: e_match_types_enum, partySize: number) => {
    try {
      return await service.verifyLobby(buildLobby(partySize), captain, type);
    } catch (error) {
      if (error instanceof JoinQueueError) {
        return false;
      }
      throw error;
    }
  };

  const cleanPlayer = (steamId: string) => ({
    name: "player",
    steam_id: steamId,
    is_banned: false,
    matchmaking_cooldown: false,
    current_lobby_id: "lobby-1",
    is_in_another_match: false,
  });

  const settingsResponse = () => ({
    settings:
      maxCompetitivePartySizeSetting === undefined
        ? []
        : [{ value: maxCompetitivePartySizeSetting }],
  });

  const perPlayerQueries = () =>
    mockHasura.query.mock.calls.filter(([query]: any[]) => query.players_by_pk);

  beforeEach(() => {
    maxCompetitivePartySizeSetting = undefined;

    // verifyPlayer runs per lobby member once the size check passes — every
    // player comes back clean so only the party-size rule can fail.
    mockHasura = {
      query: jest.fn().mockImplementation(({ players_by_pk, settings }) => {
        if (settings) {
          return settingsResponse();
        }
        return { players_by_pk: cleanPlayer(players_by_pk.__args.steam_id) };
      }),
    } as any;

    const mockRedisManager = {
      getConnection: jest.fn().mockReturnValue({ get: jest.fn().mockResolvedValue(null) } as unknown as Redis),
    } as any;

    service = new MatchmakingLobbyService(
      new Logger("Test"),
      mockHasura,
      mockRedisManager,
      {} as MatchmakeService,
      {} as any,
    );
  });

  it("rejects a player who is not the lobby captain", async () => {
    await expect(
      service.verifyLobby(
        buildLobby(2),
        { steam_id: "steam-id-2" } as User,
        "Competitive",
      ),
    ).rejects.toThrow("you are not the captain of this lobby");
  });

  describe("Duel (2 players, 1v1)", () => {
    const type: e_match_types_enum = "Duel";

    it("accepts a solo player — fills one lineup", async () => {
      await expect(canQueue(type, 1)).resolves.toBe(true);
    });

    it("rejects a full party of 2, which would just duel each other", async () => {
      await expect(canQueue(type, 2)).resolves.toBe(false);
    });

    it.each([3, 4, 5, 10, 11])("rejects a party of %i", async (size) => {
      await expect(canQueue(type, size)).resolves.toBe(false);
    });

    it("explains the requirement", async () => {
      await expect(
        service.verifyLobby(buildLobby(3), captain, type),
      ).rejects.toThrow(
        "To join a Duel match, your lobby must have 1 or fewer players. You have 3.",
      );
    });
  });

  describe("Wingman (4 players, 2v2)", () => {
    const type: e_match_types_enum = "Wingman";

    it.each([1, 2])("accepts a party of %i — fits one lineup", async (size) => {
      await expect(canQueue(type, size)).resolves.toBe(true);
    });

    it("rejects a full party of 4, no in-house split of both lineups", async () => {
      await expect(canQueue(type, 4)).resolves.toBe(false);
    });

    it("rejects a party of 3 — too big for one lineup", async () => {
      await expect(canQueue(type, 3)).resolves.toBe(false);
    });

    it.each([5, 6, 10, 11])("rejects a party of %i", async (size) => {
      await expect(canQueue(type, size)).resolves.toBe(false);
    });

    it("explains the requirement", async () => {
      await expect(
        service.verifyLobby(buildLobby(3), captain, type),
      ).rejects.toThrow(
        "To join a Wingman match, your lobby must have 2 or fewer players. You have 3.",
      );
    });
  });

  describe("Competitive (10 players, 5v5)", () => {
    const type: e_match_types_enum = "Competitive";

    it.each([1, 2, 3, 4, 5])(
      "accepts a party of %i — fits one lineup",
      async (size) => {
        await expect(canQueue(type, size)).resolves.toBe(true);
      },
    );

    it("rejects a full party of 10, no in-house split of both lineups", async () => {
      await expect(canQueue(type, 10)).resolves.toBe(false);
    });

    it.each([6, 7, 8, 9])(
      "rejects a party of %i — too big for one lineup",
      async (size) => {
        await expect(canQueue(type, size)).resolves.toBe(false);
      },
    );

    it.each([11, 12, 15, 20])(
      "rejects a party of %i — larger than the match itself",
      async (size) => {
        await expect(canQueue(type, size)).resolves.toBe(false);
      },
    );

    it("explains the requirement", async () => {
      await expect(
        service.verifyLobby(buildLobby(7), captain, type),
      ).rejects.toThrow(
        "To join a Competitive match, your lobby must have 5 or fewer players. You have 7.",
      );
    });

    it("reports the party size when it is over the full match size", async () => {
      await expect(
        service.verifyLobby(buildLobby(11), captain, type),
      ).rejects.toThrow("You have 11.");
    });
  });

  describe("Competitive max party size setting", () => {
    const type: e_match_types_enum = "Competitive";

    it("lowers the Competitive limit when an admin sets it", async () => {
      maxCompetitivePartySizeSetting = "3";

      await expect(canQueue(type, 3)).resolves.toBe(true);
      await expect(canQueue(type, 4)).resolves.toBe(false);
      await expect(
        service.verifyLobby(buildLobby(4), captain, type),
      ).rejects.toThrow(
        "To join a Competitive match, your lobby must have 3 or fewer players. You have 4.",
      );
    });

    it("allows solo-only Competitive when set to 1", async () => {
      maxCompetitivePartySizeSetting = "1";

      await expect(canQueue(type, 1)).resolves.toBe(true);
      await expect(canQueue(type, 2)).resolves.toBe(false);
    });

    it.each(["0", "6", "10", "-1", "abc", ""])(
      "falls back to 5 for an out-of-range or invalid value (%p)",
      async (value) => {
        maxCompetitivePartySizeSetting = value;

        await expect(canQueue(type, 5)).resolves.toBe(true);
        await expect(canQueue(type, 6)).resolves.toBe(false);
      },
    );

    it("does not affect Wingman or Duel", async () => {
      maxCompetitivePartySizeSetting = "1";

      await expect(canQueue("Wingman", 2)).resolves.toBe(true);
      await expect(canQueue("Duel", 1)).resolves.toBe(true);
    });
  });

  describe("the party sizes from the queue matrix", () => {
    const queueableTypes = async (size: number) => {
      const queueable: e_match_types_enum[] = [];
      for (const type of matchmakingTypes) {
        if (await canQueue(type, size)) {
          queueable.push(type);
        }
      }
      return queueable;
    };

    it("1 — every mode", async () => {
      await expect(queueableTypes(1)).resolves.toEqual([
        "Duel",
        "Wingman",
        "Competitive",
      ]);
    });

    it("2 — Wingman and Competitive (Duel is solo only)", async () => {
      await expect(queueableTypes(2)).resolves.toEqual([
        "Wingman",
        "Competitive",
      ]);
    });

    it("3 — Competitive only", async () => {
      await expect(queueableTypes(3)).resolves.toEqual(["Competitive"]);
    });

    it("4 — Competitive only (a full Wingman party is rejected)", async () => {
      await expect(queueableTypes(4)).resolves.toEqual(["Competitive"]);
    });

    it("5 — Competitive only", async () => {
      await expect(queueableTypes(5)).resolves.toEqual(["Competitive"]);
    });

    it.each([6, 7, 8, 9])("%i — nothing is queueable", async (size) => {
      await expect(queueableTypes(size)).resolves.toEqual([]);
    });

    it("10 — nothing is queueable (a full Competitive party is rejected)", async () => {
      await expect(queueableTypes(10)).resolves.toEqual([]);
    });

    it.each([11, 12, 20])(
      "%i — nothing is queueable, over every match size",
      async (size) => {
        await expect(queueableTypes(size)).resolves.toEqual([]);
      },
    );
  });

  it("stays in sync with ExpectedPlayers for every matchmaking type", async () => {
    for (const type of matchmakingTypes) {
      const expected = ExpectedPlayers[type];
      const half = expected / 2;

      await expect(canQueue(type, half)).resolves.toBe(true);
      await expect(canQueue(type, half + 1)).resolves.toBe(false);
      await expect(canQueue(type, expected)).resolves.toBe(false);
      await expect(canQueue(type, expected + 1)).resolves.toBe(false);
    }
  });

  // The size check reads the Competitive cap setting first, but must reject
  // before looking up any individual player.
  it("does not run per-player verification when the party size is invalid", async () => {
    await expect(
      service.verifyLobby(buildLobby(7), captain, "Competitive"),
    ).rejects.toThrow(JoinQueueError);

    expect(perPlayerQueries()).toHaveLength(0);
  });

  it("runs per-player verification for every member of a valid party", async () => {
    await expect(
      service.verifyLobby(buildLobby(5), captain, "Competitive"),
    ).resolves.toBe(true);

    expect(perPlayerQueries()).toHaveLength(5);
  });

  it("still rejects a valid-sized party when a member is banned", async () => {
    mockHasura.query.mockImplementation((({ players_by_pk, settings }: any) => {
      if (settings) {
        return settingsResponse();
      }
      const steamId = players_by_pk.__args.steam_id;
      return {
        players_by_pk:
          steamId === "steam-id-3"
            ? { ...cleanPlayer(steamId), name: "banned-player", is_banned: true }
            : cleanPlayer(steamId),
      };
    }) as any);

    await expect(
      service.verifyLobby(buildLobby(5), captain, "Competitive"),
    ).rejects.toThrow("banned-player is banned");
  });
});
