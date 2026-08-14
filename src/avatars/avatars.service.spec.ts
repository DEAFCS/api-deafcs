import { ForbiddenException } from "@nestjs/common";
import { AvatarsService } from "./avatars.service";
import { User } from "../auth/types/User";
import { e_player_roles_enum } from "generated";

// Roster images (general and team-specific) are Administrator/Tournament
// Organizer only, with self-service and team owner/Admin self-management
// deliberately removed. Normal avatar editing is untouched and keeps
// self-service.
describe("AvatarsService - roster image permissions", () => {
  let service: AvatarsService;
  let hasura: { query: jest.Mock; mutation: jest.Mock };
  let postgres: { transaction: jest.Mock };
  let s3: { put: jest.Mock; remove: jest.Mock; has: jest.Mock };
  let logger: { log: jest.Mock; warn: jest.Mock; error: jest.Mock };

  const user = (
    role: e_player_roles_enum,
    steamId = "76561190000000001",
  ): User => ({
    name: "Test",
    role,
    steam_id: steamId,
  });

  const ALL_ROLES: e_player_roles_enum[] = [
    "user",
    "verified_user",
    "streamer",
    "moderator",
    "match_organizer",
    "tournament_organizer",
    "administrator",
  ];
  const DENIED_ROLES = ALL_ROLES.filter(
    (r) => r !== "tournament_organizer" && r !== "administrator",
  );

  beforeEach(() => {
    hasura = { query: jest.fn(), mutation: jest.fn() };
    postgres = {
      transaction: jest.fn().mockImplementation(async (callback) =>
        callback({
          query: jest.fn().mockImplementation(async (sql: string) => {
            if (sql.includes("FROM public.players")) {
              return { rows: [{ roster_image_url: null }] };
            }
            if (sql.includes("FROM public.team_roster")) {
              return { rows: [{ roster_image_url: null }] };
            }
            if (sql.includes("SELECT EXISTS")) {
              return { rows: [{ referenced: false }] };
            }
            return { rows: [] };
          }),
        }),
      ),
    };
    s3 = {
      put: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(undefined),
      has: jest.fn().mockResolvedValue(true),
    };
    logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

    service = new AvatarsService(
      logger as any,
      s3 as any,
      hasura as any,
      postgres as any,
    );
  });

  describe("uploadPlayerRosterImage / removePlayerRosterImage (general roster image)", () => {
    it.each(DENIED_ROLES)(
      "rejects role %s uploading their OWN general roster image (self-service removed)",
      async (role) => {
        const caller = user(role);
        await expect(
          service.uploadPlayerRosterImage(
            caller.steam_id,
            caller,
            Buffer.from(""),
            "image/png",
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(hasura.query).not.toHaveBeenCalled();
      },
    );

    it.each(DENIED_ROLES)(
      "rejects role %s uploading ANOTHER player's general roster image",
      async (role) => {
        const caller = user(role, "76561190000000001");
        await expect(
          service.uploadPlayerRosterImage(
            "76561190000000002",
            caller,
            Buffer.from(""),
            "image/png",
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);
      },
    );

    it.each(["tournament_organizer", "administrator"] as const)(
      "allows role %s to upload any player's general roster image",
      async (role) => {
        hasura.query.mockResolvedValueOnce({
          players_by_pk: { roster_image_url: null },
        });
        hasura.mutation.mockResolvedValueOnce({
          update_players_by_pk: { __typename: "players" },
        });

        const caller = user(role, "76561190000000009");
        const path = await service.uploadPlayerRosterImage(
          "76561190000000002",
          caller,
          Buffer.from("x"),
          "image/png",
        );

        expect(path).toMatch(/^avatars\/roster-players\//);
        expect(s3.put).toHaveBeenCalled();
      },
    );

    it.each(DENIED_ROLES)(
      "rejects role %s removing a general roster image, including self",
      async (role) => {
        const caller = user(role);
        await expect(
          service.removePlayerRosterImage(caller.steam_id, caller),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(hasura.query).not.toHaveBeenCalled();
      },
    );

    it("allows administrator to remove a general roster image", async () => {
      hasura.query.mockResolvedValueOnce({
        players_by_pk: { roster_image_url: "avatars/roster-players/x.png" },
      });
      hasura.mutation.mockResolvedValueOnce({
        update_players_by_pk: { __typename: "players" },
      });
      postgres.transaction.mockImplementationOnce(async (callback: any) =>
        callback({
          query: jest
            .fn()
            .mockResolvedValueOnce({
              rows: [{ roster_image_url: "avatars/roster-players/x.png" }],
            })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [{ referenced: false }] }),
        }),
      );

      await expect(
        service.removePlayerRosterImage(
          "76561190000000002",
          user("administrator"),
        ),
      ).resolves.toBeUndefined();
      expect(s3.remove).toHaveBeenCalledWith("avatars/roster-players/x.png");
    });

    it("retains a replaced general image when tournament_team_roster alone references it", async () => {
      hasura.query.mockResolvedValueOnce({
        players_by_pk: { roster_image_url: "avatars/roster-players/old.png" },
      });
      const query = jest
        .fn()
        .mockResolvedValueOnce({
          rows: [{ roster_image_url: "avatars/roster-players/old.png" }],
        })
        .mockResolvedValueOnce({ rows: [] })
        // Represents the tournament_team_roster EXISTS branch returning true.
        .mockResolvedValueOnce({ rows: [{ referenced: true }] });
      postgres.transaction.mockImplementationOnce(async (callback: any) =>
        callback({ query }),
      );

      await service.uploadPlayerRosterImage(
        "76561190000000002",
        user("administrator"),
        Buffer.from("x"),
        "image/png",
      );

      expect(s3.remove).not.toHaveBeenCalledWith(
        "avatars/roster-players/old.png",
      );
      expect(query.mock.calls[2][0]).toContain(
        "FROM public.tournament_team_roster",
      );
    });

    it("retains a removed general image while a historical snapshot references it", async () => {
      hasura.query.mockResolvedValueOnce({
        players_by_pk: { roster_image_url: "avatars/roster-players/old.png" },
      });
      postgres.transaction.mockImplementationOnce(async (callback: any) =>
        callback({
          query: jest
            .fn()
            .mockResolvedValueOnce({
              rows: [{ roster_image_url: "avatars/roster-players/old.png" }],
            })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [{ referenced: true }] }),
        }),
      );

      await service.removePlayerRosterImage(
        "76561190000000002",
        user("administrator"),
      );

      expect(s3.remove).not.toHaveBeenCalledWith(
        "avatars/roster-players/old.png",
      );
    });

    it("removes the old general image when no historical snapshot references it", async () => {
      hasura.query.mockResolvedValueOnce({
        players_by_pk: { roster_image_url: "avatars/roster-players/old.png" },
      });
      postgres.transaction.mockImplementationOnce(async (callback: any) =>
        callback({
          query: jest
            .fn()
            .mockResolvedValueOnce({
              rows: [{ roster_image_url: "avatars/roster-players/old.png" }],
            })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [{ referenced: false }] }),
        }),
      );

      await service.uploadPlayerRosterImage(
        "76561190000000002",
        user("administrator"),
        Buffer.from("x"),
        "image/png",
      );

      expect(s3.remove).toHaveBeenCalledWith("avatars/roster-players/old.png");
    });
  });

  describe("uploadTeamRosterPlayerImage / removeTeamRosterPlayerImage (team-specific roster image)", () => {
    it.each(DENIED_ROLES)(
      "rejects role %s, even as team owner/Admin (self-service removed)",
      async (role) => {
        const caller = user(role);
        await expect(
          service.uploadTeamRosterPlayerImage(
            "team-1",
            "76561190000000002",
            caller,
            Buffer.from(""),
            "image/png",
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);
        // The removed self-service path used to query teams_by_pk for
        // ownership/roster role before deciding - it must no longer do so.
        expect(hasura.query).not.toHaveBeenCalled();
      },
    );

    it("rejects match_organizer (previously allowed, no longer permitted)", async () => {
      await expect(
        service.uploadTeamRosterPlayerImage(
          "team-1",
          "76561190000000002",
          user("match_organizer"),
          Buffer.from(""),
          "image/png",
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it.each(["tournament_organizer", "administrator"] as const)(
      "allows role %s to upload a team-specific roster image",
      async (role) => {
        hasura.query
          .mockResolvedValueOnce({ teams_by_pk: { id: "team-1" } })
          .mockResolvedValueOnce({
            team_roster: [{ roster_image_url: null }],
          });
        hasura.mutation.mockResolvedValueOnce({
          update_team_roster_by_pk: { __typename: "team_roster" },
        });

        const path = await service.uploadTeamRosterPlayerImage(
          "team-1",
          "76561190000000002",
          user(role),
          Buffer.from("x"),
          "image/png",
        );

        expect(path).toMatch(/^avatars\/roster-teams\//);
      },
    );

    it("retains a replaced team image when match_lineup_players alone references it", async () => {
      hasura.query
        .mockResolvedValueOnce({ teams_by_pk: { id: "team-1" } })
        .mockResolvedValueOnce({
          team_roster: [{ roster_image_url: "avatars/roster-teams/old.png" }],
        });
      const query = jest
        .fn()
        .mockResolvedValueOnce({
          rows: [{ roster_image_url: "avatars/roster-teams/old.png" }],
        })
        .mockResolvedValueOnce({ rows: [] })
        // Represents the match_lineup_players EXISTS branch returning true.
        .mockResolvedValueOnce({ rows: [{ referenced: true }] });
      postgres.transaction.mockImplementationOnce(async (callback: any) =>
        callback({ query }),
      );

      await service.uploadTeamRosterPlayerImage(
        "team-1",
        "76561190000000002",
        user("administrator"),
        Buffer.from("x"),
        "image/png",
      );

      expect(s3.remove).not.toHaveBeenCalledWith(
        "avatars/roster-teams/old.png",
      );
      expect(query.mock.calls[2][0]).toContain(
        "FROM public.match_lineup_players",
      );
    });

    it("retains a removed team image while a historical snapshot references it", async () => {
      hasura.query
        .mockResolvedValueOnce({ teams_by_pk: { id: "team-1" } })
        .mockResolvedValueOnce({
          team_roster: [{ roster_image_url: "avatars/roster-teams/old.png" }],
        });
      postgres.transaction.mockImplementationOnce(async (callback: any) =>
        callback({
          query: jest
            .fn()
            .mockResolvedValueOnce({
              rows: [{ roster_image_url: "avatars/roster-teams/old.png" }],
            })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [{ referenced: true }] }),
        }),
      );

      await service.removeTeamRosterPlayerImage(
        "team-1",
        "76561190000000002",
        user("administrator"),
      );

      expect(s3.remove).not.toHaveBeenCalledWith(
        "avatars/roster-teams/old.png",
      );
    });

    it("removes a replaced team image when no historical snapshot references it", async () => {
      hasura.query
        .mockResolvedValueOnce({ teams_by_pk: { id: "team-1" } })
        .mockResolvedValueOnce({
          team_roster: [{ roster_image_url: "avatars/roster-teams/old.png" }],
        });
      postgres.transaction.mockImplementationOnce(async (callback: any) =>
        callback({
          query: jest
            .fn()
            .mockResolvedValueOnce({
              rows: [{ roster_image_url: "avatars/roster-teams/old.png" }],
            })
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [{ referenced: false }] }),
        }),
      );

      await service.uploadTeamRosterPlayerImage(
        "team-1",
        "76561190000000002",
        user("administrator"),
        Buffer.from("x"),
        "image/png",
      );

      expect(s3.remove).toHaveBeenCalledWith("avatars/roster-teams/old.png");
    });

    it("cleans up a newly uploaded team image when the pointer transaction fails", async () => {
      hasura.query
        .mockResolvedValueOnce({ teams_by_pk: { id: "team-1" } })
        .mockResolvedValueOnce({ team_roster: [{ roster_image_url: null }] });
      postgres.transaction.mockRejectedValueOnce(new Error("database down"));

      await expect(
        service.uploadTeamRosterPlayerImage(
          "team-1",
          "76561190000000002",
          user("administrator"),
          Buffer.from("x"),
          "image/png",
        ),
      ).rejects.toThrow("database down");

      expect(s3.remove).toHaveBeenCalledWith(
        expect.stringMatching(/^avatars\/roster-teams\//),
      );
    });

    it.each(DENIED_ROLES)(
      "rejects role %s removing a team-specific roster image",
      async (role) => {
        await expect(
          service.removeTeamRosterPlayerImage(
            "team-1",
            "76561190000000002",
            user(role),
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);
      },
    );
  });

  describe("avatar self-edit regression (unaffected by the roster-image permission change)", () => {
    it("still allows a plain user to upload their OWN avatar", async () => {
      hasura.query.mockResolvedValueOnce({
        players_by_pk: { custom_avatar_url: null },
      });
      hasura.mutation.mockResolvedValueOnce({
        update_players_by_pk: { __typename: "players" },
      });

      const caller = user("user", "76561190000000002");
      const path = await service.uploadPlayerAvatar(
        caller.steam_id,
        caller,
        Buffer.from("x"),
        "image/png",
      );

      expect(path).toMatch(/^avatars\/players\//);
    });

    it("still rejects a plain user editing ANOTHER player's avatar", async () => {
      const caller = user("user", "76561190000000001");
      await expect(
        service.uploadPlayerAvatar(
          "76561190000000002",
          caller,
          Buffer.from(""),
          "image/png",
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("still allows administrator to edit any player's avatar", async () => {
      hasura.query.mockResolvedValueOnce({
        players_by_pk: { custom_avatar_url: null },
      });
      hasura.mutation.mockResolvedValueOnce({
        update_players_by_pk: { __typename: "players" },
      });

      const path = await service.uploadPlayerAvatar(
        "76561190000000002",
        user("administrator", "76561190000000009"),
        Buffer.from("x"),
        "image/png",
      );

      expect(path).toMatch(/^avatars\/players\//);
    });
  });
});
