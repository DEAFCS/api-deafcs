jest.mock("crypto", () => {
  const actual = jest.requireActual("crypto");
  return { ...actual, randomInt: jest.fn(actual.randomInt) };
});

import { Logger } from "@nestjs/common";
import { randomInt } from "crypto";
import { FakeQueue, FakeRedis } from "../../../test/mocks/fake-redis";
import {
  CaptainPickActionError,
  CaptainPickFinalizeBusyError,
  CaptainPickService,
  CaptainPickState,
  CAPTAIN_PICK_FINALIZE_ATTEMPTS,
  getCaptainPickShellKey,
  getCaptainPickTimeoutJobId,
} from "./captain-pick.service";
import { getPickingLineup } from "./captain-pick-rules";
import {
  getCaptainPickDraftCacheKey,
  getCaptainPickPlayerCacheKey,
  getMatchConfirmationKey,
  getMatchmakingConformationCacheKey,
} from "../utilities/cacheKeys";
import { CaptainPickFinalize } from "../jobs/CaptainPickFinalize";
import { CaptainPickTimeout } from "../jobs/CaptainPickTimeout";

const CONFIRMATION_ID = "11111111-1111-4111-8111-111111111111";
const REGION = "Europe";
const START = new Date("2026-09-29T18:00:00.000Z").getTime();

const steam = (n: number) => `765611980000000${String(n).padStart(2, "0")}`;

// Player n: the lower n, the higher the ELO. 1 and 2 captain.
const ELO: Record<number, number> = {
  1: 12500,
  2: 11900,
  3: 9000,
  4: 8500,
  5: 8000,
  6: 7000,
  7: 6000,
  8: 5000,
  9: 4000,
  10: 3000,
};

type Match = {
  id: string;
  status: string;
  source: string;
  region: string;
  lineup_1_id: string;
  lineup_2_id: string;
  options: {
    type: string;
    mr: number;
    best_of: number;
    knife_round: boolean;
    overtime: boolean;
    timeout_setting: string;
    map_veto: boolean;
    map_pool: { type: string };
  };
  draft_games: Array<{ id: string }>;
};

// What insert_matches_one inside createMatchBasedOnType writes: the enabled
// pool for the map pool type (so map_veto is on) and the 5stack source
// default, with two empty lineups.
const matchRow = (
  matchType: string,
  mapPoolType: string,
  options: any,
): Match => ({
  id: options.id,
  status: "PickingPlayers",
  source: "5stack",
  region: options.region,
  lineup_1_id: `${options.id}-lineup-1`,
  lineup_2_id: `${options.id}-lineup-2`,
  options: {
    type: matchType,
    mr: options.mr,
    best_of: options.best_of,
    knife_round: options.knife,
    overtime: options.overtime,
    timeout_setting: options.timeout_setting,
    map_veto: true,
    map_pool: { type: mapPoolType },
  },
  draft_games: [],
});

describe("CaptainPickService", () => {
  let redis: FakeRedis;
  let queue: FakeQueue;
  let service: CaptainPickService;
  let pickSeconds: number;
  let players: Map<string, any>;
  let matches: Map<string, Match>;
  let lineupPlayers: Array<{
    match_lineup_id: string;
    steam_id: string;
    captain: boolean;
  }>;
  let hasura: { query: jest.Mock; mutation: jest.Mock };
  let matchAssistant: {
    createMatchBasedOnType: jest.Mock;
    updateMatchStatus: jest.Mock;
  };
  let failNextLineupInsert: boolean;
  // Status transitions that fail with the given error, e.g. a region with no
  // servers making Live raise in tbu_matches.
  let failStatus: Record<string, string>;

  const setNow = (ms: number) => jest.setSystemTime(ms);

  const writeConfirmation = async (
    ids: number[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  ) => {
    await redis.hset(getMatchmakingConformationCacheKey(CONFIRMATION_ID), {
      type: "Competitive",
      variant: "CaptainPick",
      region: REGION,
      expiresAt: new Date(START + 30000).toISOString(),
      lobbyIds: JSON.stringify(ids.map(steam)),
      // Queue order is deliberately not ELO order.
      participants: JSON.stringify(
        ids.map((n) => ({
          steam_id: steam(n),
          lobbyId: steam(n),
          joinedAt: new Date(START - (20 - n) * 1000).toISOString(),
          // A stale/forged rank must never be used for captains.
          rank: 99999,
        })),
      ),
      team1: "[]",
      team2: "[]",
    });
  };

  const state = async () =>
    (await service.getState(CONFIRMATION_ID)) as CaptainPickState;

  // The current captain picks (by default) the first player still available.
  const pickNext = async (target?: string) => {
    const current = await state();
    const lineup = getPickingLineup(current.draft.pickIndex as number);
    const captain = current.draft.captains[lineup].steam_id;
    await service.pick(
      CONFIRMATION_ID,
      captain,
      target ?? current.draft.available[0].steam_id,
      current.draft.pickIndex as number,
    );
  };

  const draftToCompletion = async () => {
    for (let i = 0; i < 7; i++) {
      await pickNext();
    }
  };

  beforeEach(async () => {
    jest.useFakeTimers({
      doNotFake: [
        "setImmediate",
        "nextTick",
        "queueMicrotask",
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
      ],
    });
    setNow(START);
    (randomInt as jest.Mock).mockClear();

    redis = new FakeRedis();
    queue = new FakeQueue();
    pickSeconds = 30;
    failNextLineupInsert = false;
    failStatus = {};

    players = new Map(
      Object.entries(ELO).map(([n, elo]) => [
        steam(Number(n)),
        {
          name: `Player ${n}`,
          avatar_url: `https://avatars/${n}.jpg`,
          elo: { competitive: elo, wingman: 1 },
        },
      ]),
    );
    matches = new Map();
    lineupPlayers = [];

    hasura = {
      query: jest.fn(async (query: any) => {
        if (query.players) {
          return {
            players: query.players.__args.where.steam_id._in
              .filter((id: string) => players.has(id))
              .map((id: string) => ({ steam_id: id, ...players.get(id) })),
          };
        }
        if (query.matches_by_pk) {
          const match = matches.get(query.matches_by_pk.__args.id);
          const seatedIn = (lineupId: string) =>
            lineupPlayers
              .filter((p) => p.match_lineup_id === lineupId)
              .map(({ steam_id, captain }) => ({ steam_id, captain }));
          return {
            matches_by_pk: match
              ? {
                  ...structuredClone(match),
                  lineup_1: { lineup_players: seatedIn(match.lineup_1_id) },
                  lineup_2: { lineup_players: seatedIn(match.lineup_2_id) },
                }
              : null,
          };
        }
        if (query.match_lineup_players) {
          const lineupId =
            query.match_lineup_players.__args.where.match_lineup_id._eq;
          return {
            match_lineup_players: lineupPlayers
              .filter((p) => p.match_lineup_id === lineupId)
              .map((p) => ({ ...p })),
          };
        }
        throw new Error(`unexpected query ${Object.keys(query)}`);
      }),
      mutation: jest.fn(async (mutation: any) => {
        if (mutation.insert_match_lineup_players) {
          if (failNextLineupInsert) {
            failNextLineupInsert = false;
            throw new Error("database unavailable");
          }
          // tbid_match_lineup_players: the first row into an empty lineup
          // becomes captain.
          for (const object of mutation.insert_match_lineup_players.__args
            .objects) {
            const empty = !lineupPlayers.some(
              (p) => p.match_lineup_id === object.match_lineup_id,
            );
            lineupPlayers.push({ ...object, captain: empty });
          }
          return {};
        }
        if (mutation.update_match_lineup_players) {
          const { where } = mutation.update_match_lineup_players.__args;
          // tau_match_lineup_players clears the flag on everyone else.
          for (const p of lineupPlayers) {
            if (p.match_lineup_id === where.match_lineup_id._eq) {
              p.captain = p.steam_id === where.steam_id._eq;
            }
          }
          return {};
        }
        throw new Error(`unexpected mutation ${Object.keys(mutation)}`);
      }),
    };

    matchAssistant = {
      createMatchBasedOnType: jest.fn(async (type, pool, options) => {
        if (matches.has(options.id)) {
          throw new Error("duplicate key value violates matches_pkey");
        }
        const match = matchRow(type, pool, options);
        matches.set(options.id, match);
        return match;
      }),
      // tbu_matches: Live without a map becomes the normal map veto.
      updateMatchStatus: jest.fn(async (id: string, status: string) => {
        if (failStatus[status]) {
          throw new Error(failStatus[status]);
        }
        const match = matches.get(id);
        match.status = status === "Live" ? "Veto" : status;
      }),
    };

    service = new CaptainPickService(
      new Logger("Test"),
      hasura as any,
      { getConnection: () => redis } as any,
      matchAssistant as any,
      {
        getSettings: jest.fn(async () => ({ enabled: true, pickSeconds })),
      } as any,
      queue as any,
    );
    jest.spyOn((service as any).logger, "log").mockImplementation(() => {});
    jest.spyOn((service as any).logger, "error").mockImplementation(() => {});

    await writeConfirmation();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("starting the draft", () => {
    it("picks the two highest fresh server ELOs as captains, lower one first", async () => {
      await service.startDraft(CONFIRMATION_ID);
      const s = await state();

      expect(s.phase).toBe("Drafting");
      expect(s.draft.captains[1].steam_id).toBe(steam(2));
      expect(s.draft.captains[2].steam_id).toBe(steam(1));
      expect(s.draft.firstPickReason).toBe("LowerElo");
      expect(s.coinFlip).toBeNull();
      expect(s.draft.lineups).toEqual({ 1: [steam(2)], 2: [steam(1)] });
      expect(s.draft.available).toHaveLength(8);
      expect(s.participants.find((p) => p.steam_id === steam(1))).toMatchObject(
        { elo: 12500, name: "Player 1", avatar_url: "https://avatars/1.jpg" },
      );
      expect(randomInt).not.toHaveBeenCalled();
    });

    it("uses the Competitive ELO, not the queue-time rank or another mode", async () => {
      await service.startDraft(CONFIRMATION_ID);
      const s = await state();

      for (const participant of s.participants) {
        expect(participant.elo).not.toBe(99999);
        expect(participant.elo).not.toBe(1);
      }
    });

    it("treats a player with no Competitive ELO as 5000", async () => {
      players.set(steam(10), { name: "New", avatar_url: null, elo: {} });

      await service.startDraft(CONFIRMATION_ID);
      const s = await state();

      expect(s.participants.find((p) => p.steam_id === steam(10))?.elo).toBe(
        5000,
      );
    });

    it("starts a 30 second deadline with a timeout job for that exact pick", async () => {
      await service.startDraft(CONFIRMATION_ID);
      const s = await state();

      expect(s.timer).toEqual({
        startedAt: new Date(START).toISOString(),
        timerSeconds: 30,
        deadline: new Date(START + 30000).toISOString(),
      });

      const [job] = queue.byName("CaptainPickTimeout");
      expect(job.data).toEqual({
        confirmationId: CONFIRMATION_ID,
        pickIndex: 0,
        deadline: s.timer?.deadline,
      });
      expect(job.opts.delay).toBe(30000);
      expect(job.opts.jobId).toBe(
        getCaptainPickTimeoutJobId(CONFIRMATION_ID, 0, s.timer!.deadline),
      );
    });

    it("uses the configured timer", async () => {
      pickSeconds = 45;
      await service.startDraft(CONFIRMATION_ID);

      expect((await state()).timer?.timerSeconds).toBe(45);
    });

    it("marks every participant as committed to this draft", async () => {
      await service.startDraft(CONFIRMATION_ID);

      for (let n = 1; n <= 10; n++) {
        await expect(service.getActiveDraftId(steam(n))).resolves.toBe(
          CONFIRMATION_ID,
        );
      }
    });

    it("sends the draft to all ten players with the server time", async () => {
      await service.startDraft(CONFIRMATION_ID);

      for (let n = 1; n <= 10; n++) {
        const [message] = redis.messagesTo(steam(n), "matchmaking:details");
        expect(message.data.confirmation).toMatchObject({
          confirmationId: CONFIRMATION_ID,
          type: "Competitive",
          variant: "CaptainPick",
          confirmed: 10,
          players: 10,
        });
        expect(message.data.confirmation.captainPick).toMatchObject({
          draftId: CONFIRMATION_ID,
          phase: "Drafting",
          pickIndex: 0,
          pickingLineup: 1,
          pickingCaptainSteamId: steam(2),
          serverNow: new Date(START).toISOString(),
          deadline: new Date(START + 30000).toISOString(),
          pickOrder: [1, 2, 2, 1, 1, 2, 2],
          // The real match already exists (see "the match shell").
          matchId: (await state()).matchId,
        });
        // ...but the ready-check/matchmaking routing field stays empty, so
        // nobody is sent to the match page before the teams are seated.
        expect(message.data.confirmation.matchId).toBeUndefined();
      }
    });

    it("only ever creates one draft, even when started twice at once", async () => {
      await Promise.all([
        service.startDraft(CONFIRMATION_ID),
        service.startDraft(CONFIRMATION_ID),
      ]);
      const first = await state();

      await service.startDraft(CONFIRMATION_ID);

      expect(await state()).toEqual(first);
      expect(
        redis.hashes
          .get(getCaptainPickDraftCacheKey(CONFIRMATION_ID))
          ?.get("version"),
      ).toBe("1");
    });

    it("refuses to start without ten participants", async () => {
      await redis.del(getMatchmakingConformationCacheKey(CONFIRMATION_ID));
      await writeConfirmation([1, 2, 3, 4, 5, 6, 7, 8, 9]);

      await expect(service.startDraft(CONFIRMATION_ID)).rejects.toThrow(
        /9 participants/,
      );
      expect(await service.hasDraft(CONFIRMATION_ID)).toBe(false);
    });

    describe("equal-ELO captains", () => {
      beforeEach(() => {
        players.get(steam(2)).elo.competitive = 12500;
      });

      it("uses a server-side crypto coin flip and stores it", async () => {
        (randomInt as jest.Mock).mockReturnValueOnce(1);

        await service.startDraft(CONFIRMATION_ID);
        const s = await state();

        expect(randomInt).toHaveBeenCalledWith(2);
        expect(s.coinFlip).toBe(1);
        expect(s.draft.firstPickReason).toBe("EqualEloCoinFlip");
        // Captains in priority order: 1 queued earlier, so index 1 is player 2.
        expect(s.draft.captains[1].steam_id).toBe(steam(2));
      });

      it("never rerolls on a repeated start, reconnect or publish", async () => {
        (randomInt as jest.Mock).mockReturnValueOnce(0);
        await service.startDraft(CONFIRMATION_ID);
        const first = (await state()).draft.captains[1].steam_id;

        (randomInt as jest.Mock).mockReturnValue(1);
        await service.startDraft(CONFIRMATION_ID);
        await service.publishState(CONFIRMATION_ID);

        expect((await state()).draft.captains[1].steam_id).toBe(first);
        expect((await state()).coinFlip).toBe(0);
        (randomInt as jest.Mock).mockImplementation(
          jest.requireActual("crypto").randomInt,
        );
      });
    });
  });

  describe("manual picks", () => {
    beforeEach(async () => {
      await service.startDraft(CONFIRMATION_ID);
    });

    it("follows A B B A A B B and auto-assigns the last player to A", async () => {
      const turns: string[] = [];
      for (let i = 0; i < 7; i++) {
        const s = await state();
        const lineup = getPickingLineup(s.draft.pickIndex as number);
        turns.push(lineup === 1 ? "A" : "B");
        await pickNext();
      }

      const s = await state();
      expect(turns.join("")).toBe("ABBAABB");
      expect(s.phase).toBe("CreatingMatch");
      expect(s.draft.selections).toHaveLength(7);
      expect(s.draft.lineups[1]).toHaveLength(5);
      expect(s.draft.lineups[2]).toHaveLength(5);
      expect(new Set([...s.draft.lineups[1], ...s.draft.lineups[2]]).size).toBe(
        10,
      );
      expect(s.draft.lineups[1][0]).toBe(steam(2));
      expect(s.draft.lineups[2][0]).toBe(steam(1));
      // Seven timed picks only: no timer and no 8th selection.
      expect(s.timer).toBeNull();
      expect(queue.byName("CaptainPickTimeout")).toHaveLength(7);
    });

    it("records who picked and when", async () => {
      setNow(START + 4000);
      await service.pick(CONFIRMATION_ID, steam(2), steam(7), 0);

      const s = await state();
      expect(s.draft.selections).toEqual([
        { pickIndex: 0, lineup: 1, steam_id: steam(7), auto: false },
      ]);
      const publicState = service.toPublicState(s);
      expect(publicState.picks).toEqual([
        {
          pickIndex: 0,
          lineup: 1,
          steam_id: steam(7),
          auto: false,
          captain_steam_id: steam(2),
          at: new Date(START + 4000).toISOString(),
        },
      ]);
    });

    it("rejects the other captain", async () => {
      await expect(
        service.pick(CONFIRMATION_ID, steam(1), steam(5), 0),
      ).rejects.toThrow("It is not your turn to pick.");
    });

    it("rejects a participant who is not a captain", async () => {
      await expect(
        service.pick(CONFIRMATION_ID, steam(5), steam(6), 0),
      ).rejects.toThrow("It is not your turn to pick.");
    });

    it("rejects someone outside the draft", async () => {
      await expect(
        service.pick(CONFIRMATION_ID, steam(99), steam(6), 0),
      ).rejects.toThrow("You are not in this draft.");
    });

    it("rejects picking a captain, themselves or an unknown player", async () => {
      for (const target of [steam(1), steam(2), steam(99)]) {
        await expect(
          service.pick(CONFIRMATION_ID, steam(2), target, 0),
        ).rejects.toThrow("That player can't be picked.");
      }
    });

    it("rejects a player who was already picked", async () => {
      await service.pick(CONFIRMATION_ID, steam(2), steam(5), 0);

      await expect(
        service.pick(CONFIRMATION_ID, steam(1), steam(5), 1),
      ).rejects.toThrow("That player can't be picked.");
    });

    it("rejects a stale pick index (double click)", async () => {
      await service.pick(CONFIRMATION_ID, steam(2), steam(5), 0);
      await service.pick(CONFIRMATION_ID, steam(1), steam(6), 1);

      // Captain B has picks 1 and 2 back to back; a repeat of pick 1 must not
      // become pick 2.
      await expect(
        service.pick(CONFIRMATION_ID, steam(1), steam(7), 1),
      ).rejects.toThrow("That pick has already been made.");
      expect((await state()).draft.selections).toHaveLength(2);
    });

    it("accepts a click just inside the grace period and rejects a late one", async () => {
      setNow(START + 30400);
      await service.pick(CONFIRMATION_ID, steam(2), steam(5), 0);

      const s = await state();
      setNow(new Date(s.timer!.deadline).getTime() + 600);
      await expect(
        service.pick(CONFIRMATION_ID, steam(1), steam(6), 1),
      ).rejects.toThrow("Time ran out for this pick.");
    });

    it("rejects picks once the teams are locked", async () => {
      await draftToCompletion();

      await expect(
        service.pick(CONFIRMATION_ID, steam(2), steam(10), 7),
      ).rejects.toBeInstanceOf(CaptainPickActionError);
    });

    it("lets exactly one of several simultaneous picks win", async () => {
      const results = await Promise.allSettled([
        service.pick(CONFIRMATION_ID, steam(2), steam(5), 0),
        service.pick(CONFIRMATION_ID, steam(2), steam(6), 0),
        service.pick(CONFIRMATION_ID, steam(2), steam(7), 0),
      ]);

      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect((await state()).draft.selections).toHaveLength(1);
    });
  });

  describe("pick timer and auto-pick", () => {
    beforeEach(async () => {
      await service.startDraft(CONFIRMATION_ID);
    });

    const timeout = async () => {
      const s = await state();
      setNow(new Date(s.timer!.deadline).getTime());
      await service.handleTimeout(
        CONFIRMATION_ID,
        s.draft.pickIndex as number,
        s.timer!.deadline,
      );
    };

    it("auto-picks the highest remaining ELO for the captain on turn", async () => {
      await timeout();

      const s = await state();
      expect(s.draft.selections).toEqual([
        { pickIndex: 0, lineup: 1, steam_id: steam(3), auto: true },
      ]);
      expect(service.toPublicState(s).picks[0].auto).toBe(true);
    });

    it("breaks ELO ties by earlier queue time, then steam id", async () => {
      players.get(steam(4)).elo.competitive = 9000;
      players.get(steam(3)).elo.competitive = 9000;
      await redis.del(getCaptainPickDraftCacheKey(CONFIRMATION_ID));
      await service.startDraft(CONFIRMATION_ID);

      // 3 queued before 4 (joinedAt ascends with n).
      await timeout();
      expect((await state()).draft.selections[0].steam_id).toBe(steam(3));
    });

    it("keeps auto-picking an absent captain to a full 5v5", async () => {
      for (let i = 0; i < 7; i++) {
        await timeout();
      }

      const s = await state();
      expect(s.phase).toBe("CreatingMatch");
      expect(s.draft.selections.every((selection) => selection.auto)).toBe(
        true,
      );
      expect(s.draft.lineups[1]).toHaveLength(5);
      expect(s.draft.lineups[2]).toHaveLength(5);
    });

    it("snapshots the timer when each pick starts", async () => {
      const first = (await state()).timer!;
      pickSeconds = 20;

      // The running pick keeps its 30 seconds.
      expect((await state()).timer).toEqual(first);

      setNow(START + 5000);
      await service.pick(CONFIRMATION_ID, steam(2), steam(5), 0);

      const second = (await state()).timer!;
      expect(second.timerSeconds).toBe(20);
      expect(second.deadline).toBe(new Date(START + 25000).toISOString());
    });

    it("ignores a stale timeout from an earlier pick", async () => {
      const first = (await state()).timer!.deadline;
      await service.pick(CONFIRMATION_ID, steam(2), steam(5), 0);

      setNow(new Date(first).getTime() + 1000);
      await service.handleTimeout(CONFIRMATION_ID, 0, first);

      expect((await state()).draft.selections).toHaveLength(1);
    });

    it("ignores a timeout carrying a different deadline for the same pick", async () => {
      setNow(START + 60000);
      await service.handleTimeout(
        CONFIRMATION_ID,
        0,
        new Date(START + 1000).toISOString(),
      );

      expect((await state()).draft.selections).toHaveLength(0);
    });

    it("ignores a duplicate timeout", async () => {
      const s = await state();
      setNow(new Date(s.timer!.deadline).getTime());
      await service.handleTimeout(CONFIRMATION_ID, 0, s.timer!.deadline);
      await service.handleTimeout(CONFIRMATION_ID, 0, s.timer!.deadline);

      expect((await state()).draft.selections).toHaveLength(1);
    });

    it("does nothing if it fires early, and reschedules itself", async () => {
      const s = await state();
      setNow(START + 10000);
      await service.handleTimeout(CONFIRMATION_ID, 0, s.timer!.deadline);

      expect((await state()).draft.selections).toHaveLength(0);
      expect(
        queue.added.filter(
          (job) =>
            job.name === "CaptainPickTimeout" &&
            job.opts.jobId.includes(".retry-"),
        ),
      ).toHaveLength(1);
    });

    it("does nothing once the teams are locked", async () => {
      await draftToCompletion();
      const before = await state();

      await service.handleTimeout(
        CONFIRMATION_ID,
        6,
        new Date(START).toISOString(),
      );

      expect(await state()).toEqual(before);
    });

    it("lets exactly one of a timeout and a last-moment click win", async () => {
      const s = await state();
      setNow(new Date(s.timer!.deadline).getTime() + 100);

      const results = await Promise.allSettled([
        service.pick(CONFIRMATION_ID, steam(2), steam(9), 0),
        service.handleTimeout(CONFIRMATION_ID, 0, s.timer!.deadline),
      ]);

      const after = await state();
      expect(after.draft.selections).toHaveLength(1);
      expect(after.draft.pickIndex).toBe(1);
      const pickWon = results[0].status === "fulfilled";
      expect(after.draft.selections[0].auto).toBe(!pickWon);
    });

    it("repairs a pick whose timeout job was lost when the state is read", async () => {
      const s = await state();
      setNow(new Date(s.timer!.deadline).getTime() + 6000);

      await service.publishState(CONFIRMATION_ID);
      // The repair runs in the background.
      for (let i = 0; i < 50; i++) {
        await new Promise((resolve) => setImmediate(resolve));
      }

      expect((await state()).draft.selections).toEqual([
        { pickIndex: 0, lineup: 1, steam_id: steam(3), auto: true },
      ]);
    });

    it("runs through the BullMQ job", async () => {
      const job = new CaptainPickTimeout(service);
      const s = await state();
      setNow(new Date(s.timer!.deadline).getTime());

      await job.process({
        data: {
          confirmationId: CONFIRMATION_ID,
          pickIndex: 0,
          deadline: s.timer!.deadline,
        },
      } as any);

      expect((await state()).draft.selections).toHaveLength(1);
    });

    it("the job does nothing for a draft that no longer exists", async () => {
      await service.cleanup(CONFIRMATION_ID);

      await expect(
        new CaptainPickTimeout(service).process({
          data: {
            confirmationId: CONFIRMATION_ID,
            pickIndex: 0,
            deadline: new Date(START).toISOString(),
          },
        } as any),
      ).resolves.toBeUndefined();
    });
  });

  describe("finalizing the match", () => {
    beforeEach(async () => {
      await service.startDraft(CONFIRMATION_ID);
      await draftToCompletion();
    });

    it("locks the teams with a pre-generated match id and queues one finalize job", async () => {
      const s = await state();

      expect(s.phase).toBe("CreatingMatch");
      expect(s.matchId).toMatch(/^[0-9a-f-]{36}$/);
      expect(service.toPublicState(s).matchId).toBeNull();

      const finalizeJobs = queue.byName("CaptainPickFinalize");
      expect(finalizeJobs).toHaveLength(1);
      expect(finalizeJobs[0].opts).toMatchObject({
        attempts: CAPTAIN_PICK_FINALIZE_ATTEMPTS,
        jobId: `matchmaking.captain-pick-finalize.${CONFIRMATION_ID}`,
      });
    });

    it("creates an ordinary Competitive match with the Standard options and normal veto", async () => {
      await service.finalize(CONFIRMATION_ID);
      const s = await state();

      expect(matchAssistant.createMatchBasedOnType).toHaveBeenCalledTimes(1);
      const [type, mapPoolType, options] =
        matchAssistant.createMatchBasedOnType.mock.calls[0];
      expect(type).toBe("Competitive");
      expect(mapPoolType).toBe("Competitive");
      // Exactly Standard 5v5's options: no map, maps or veto override.
      expect(options).toEqual({
        mr: 12,
        best_of: 1,
        knife: true,
        overtime: true,
        timeout_setting: "CoachAndPlayers",
        region: REGION,
        id: s.matchId,
      });

      expect(matchAssistant.updateMatchStatus).toHaveBeenCalledWith(
        s.matchId,
        "Live",
      );
      expect(matches.get(s.matchId!)?.status).toBe("Veto");
      expect(s.phase).toBe("MatchCreated");
    });

    it("never touches draft_games", async () => {
      await service.finalize(CONFIRMATION_ID);

      for (const [operation] of [
        ...hasura.query.mock.calls,
        ...hasura.mutation.mock.calls,
      ]) {
        expect(JSON.stringify(Object.keys(operation))).not.toMatch(/draft/);
      }
    });

    it("seats the drafted teams 5v5 with the drafted captains as lineup captains", async () => {
      await service.finalize(CONFIRMATION_ID);
      const s = await state();
      const match = matches.get(s.matchId!);

      for (const [lineup, lineupId] of [
        [1, match.lineup_1_id],
        [2, match.lineup_2_id],
      ] as const) {
        const seated = lineupPlayers.filter(
          (p) => p.match_lineup_id === lineupId,
        );
        expect(seated.map((p) => p.steam_id)).toEqual(s.draft.lineups[lineup]);
        expect(seated.filter((p) => p.captain).map((p) => p.steam_id)).toEqual([
          s.draft.captains[lineup].steam_id,
        ]);
      }
    });

    it("records the match on the confirmation and announces it", async () => {
      await service.finalize(CONFIRMATION_ID);
      const s = await state();

      expect(
        await redis.hget(
          getMatchmakingConformationCacheKey(CONFIRMATION_ID),
          "matchId",
        ),
      ).toBe(s.matchId);
      expect(await redis.get(`matches:confirmation:${s.matchId}`)).toBe(
        CONFIRMATION_ID,
      );

      const last = redis.messagesTo(steam(5), "matchmaking:details").at(-1);
      expect(last.data.confirmation.matchId).toBe(s.matchId);
      expect(last.data.confirmation.captainPick.phase).toBe("MatchCreated");
    });

    it("creates only one match when finalized repeatedly", async () => {
      await service.finalize(CONFIRMATION_ID);
      await service.finalize(CONFIRMATION_ID);

      expect(matchAssistant.createMatchBasedOnType).toHaveBeenCalledTimes(1);
      expect(matches.size).toBe(1);
      expect(lineupPlayers).toHaveLength(10);
    });

    it("resumes after a crash mid-way without a second match", async () => {
      failNextLineupInsert = true;
      await expect(service.finalize(CONFIRMATION_ID)).rejects.toThrow(
        "database unavailable",
      );
      expect(matches.size).toBe(1);

      await service.finalize(CONFIRMATION_ID);

      expect(matchAssistant.createMatchBasedOnType).toHaveBeenCalledTimes(1);
      expect(matches.size).toBe(1);
      expect(lineupPlayers).toHaveLength(10);
      expect((await state()).phase).toBe("MatchCreated");
    });

    it("adopts a match a concurrent attempt already inserted", async () => {
      const s = await state();
      matchAssistant.createMatchBasedOnType.mockImplementationOnce(
        async (type, pool, options) => {
          matches.set(options.id, matchRow(type, pool, options));
          throw new Error("duplicate key value violates matches_pkey");
        },
      );

      await service.finalize(CONFIRMATION_ID);

      expect(matches.size).toBe(1);
      expect(matches.has(s.matchId!)).toBe(true);
      expect((await state()).phase).toBe("MatchCreated");
    });

    it("refuses to run twice at the same time", async () => {
      matchAssistant.createMatchBasedOnType.mockClear();
      await redis.set(
        `${getCaptainPickDraftCacheKey(CONFIRMATION_ID)}:finalize-lock`,
        1,
      );

      await expect(service.finalize(CONFIRMATION_ID)).rejects.toBeInstanceOf(
        CaptainPickFinalizeBusyError,
      );
      expect(matchAssistant.createMatchBasedOnType).not.toHaveBeenCalled();
    });

    it("refuses to change a lineup that doesn't match the draft", async () => {
      const s = await state();
      await service.finalize(CONFIRMATION_ID).catch(() => {});
      // Recreate the situation: a lineup already holding someone else.
      await redis.hset(getCaptainPickDraftCacheKey(CONFIRMATION_ID), {
        state: JSON.stringify({ ...s, phase: "CreatingMatch" }),
      });
      lineupPlayers.pop();

      await expect(service.finalize(CONFIRMATION_ID)).rejects.toThrow(
        /does not match the drafted team/,
      );
    });

    describe("the finalize job", () => {
      const job = (attemptsMade: number) =>
        ({
          data: { confirmationId: CONFIRMATION_ID },
          opts: { attempts: CAPTAIN_PICK_FINALIZE_ATTEMPTS },
          attemptsMade,
        }) as any;

      it("retries a transient failure", async () => {
        failNextLineupInsert = true;

        await expect(
          new CaptainPickFinalize(service).process(job(0)),
        ).rejects.toThrow("database unavailable");
        expect((await state()).phase).toBe("CreatingMatch");
      });

      it("on the last attempt cancels the half-created match, then releases everyone", async () => {
        failNextLineupInsert = true;

        await new CaptainPickFinalize(service).process(
          job(CAPTAIN_PICK_FINALIZE_ATTEMPTS - 1),
        );

        // The match row existed with empty lineups: it is canceled first.
        expect(matches.size).toBe(1);
        expect([...matches.values()][0].status).toBe("Canceled");
        expect(await service.hasDraft(CONFIRMATION_ID)).toBe(false);
        for (let n = 1; n <= 10; n++) {
          await expect(service.getActiveDraftId(steam(n))).resolves.toBeNull();
          expect(
            redis.messagesTo(steam(n), "matchmaking:error").at(-1).data.message,
          ).toBe(
            "The Captain Pick match could not be created. Please queue again.",
          );
        }
      });

      it("never gives up just because another runner holds the lock", async () => {
        await redis.set(
          `${getCaptainPickDraftCacheKey(CONFIRMATION_ID)}:finalize-lock`,
          1,
        );

        await new CaptainPickFinalize(service).process(
          job(CAPTAIN_PICK_FINALIZE_ATTEMPTS - 1),
        );

        expect((await state()).phase).toBe("CreatingMatch");
        expect(await service.getActiveDraftId(steam(1))).toBe(CONFIRMATION_ID);
        // Tries again later instead.
        expect(
          queue.added.filter((j) => j.data.recovery === true),
        ).toHaveLength(1);
      });

      it("a recovery job only resolves, it never creates a match", async () => {
        // The shell could never be created (e.g. Postgres down all along).
        matches.clear();
        matchAssistant.createMatchBasedOnType.mockClear();

        await new CaptainPickFinalize(service).process({
          data: { confirmationId: CONFIRMATION_ID, recovery: true },
          opts: {},
          attemptsMade: 0,
        } as any);

        // No match existed: resolved as a clean failure.
        expect(matchAssistant.createMatchBasedOnType).not.toHaveBeenCalled();
        expect(await service.hasDraft(CONFIRMATION_ID)).toBe(false);
      });
    });
  });

  describe("the match shell", () => {
    const mapping = (matchId: string) =>
      redis.get(getMatchConfirmationKey(matchId));
    const shellReady = () => redis.get(getCaptainPickShellKey(CONFIRMATION_ID));

    describe("at 10/10", () => {
      it("fixes the match id and creates one ordinary Competitive match, still picking players", async () => {
        await service.startDraft(CONFIRMATION_ID);
        const s = await state();

        expect(s.phase).toBe("Drafting");
        expect(s.matchId).toEqual(expect.any(String));
        expect(matchAssistant.createMatchBasedOnType).toHaveBeenCalledTimes(1);
        expect(matchAssistant.createMatchBasedOnType).toHaveBeenCalledWith(
          "Competitive",
          "Competitive",
          expect.objectContaining({ id: s.matchId, region: REGION }),
        );
        expect([...matches.keys()]).toEqual([s.matchId]);
        expect(matches.get(s.matchId!)!.status).toBe("PickingPlayers");
        // Nobody seated, no veto, no server.
        expect(lineupPlayers).toEqual([]);
        expect(matchAssistant.updateMatchStatus).not.toHaveBeenCalled();
        expect(await mapping(s.matchId!)).toBe(CONFIRMATION_ID);
        expect(await shellReady()).toBe(s.matchId);
      });

      it("keeps the draft running when the match can't be created yet, and retries on the next publish", async () => {
        // Down for the start and for the retry right after it.
        matchAssistant.createMatchBasedOnType
          .mockRejectedValueOnce(new Error("database unavailable"))
          .mockRejectedValueOnce(new Error("database unavailable"));
        jest
          .spyOn((service as any).logger, "warn")
          .mockImplementation(() => {});

        await service.startDraft(CONFIRMATION_ID);
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
        const s = await state();

        expect(s.phase).toBe("Drafting");
        expect(matches.size).toBe(0);
        const [first] = redis.messagesTo(steam(1), "matchmaking:details");
        // No unannounced match id while it doesn't exist.
        expect(first.data.confirmation.captainPick.matchId).toBeNull();

        // A pick still works without the database.
        await pickNext();
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));

        // The retry created the same fixed-id match and announced it.
        expect([...matches.keys()]).toEqual([s.matchId]);
        expect(
          redis.messagesTo(steam(1), "matchmaking:details").at(-1).data
            .confirmation.captainPick.matchId,
        ).toBe(s.matchId);
      });
    });

    describe("idempotency", () => {
      it("never creates a second match on repeated starts or recovery", async () => {
        await Promise.all([
          service.startDraft(CONFIRMATION_ID),
          service.startDraft(CONFIRMATION_ID),
        ]);
        await service.startDraft(CONFIRMATION_ID);
        await service.ensureMatchShell(CONFIRMATION_ID);
        await redis.del(getCaptainPickShellKey(CONFIRMATION_ID));
        await service.ensureMatchShell(CONFIRMATION_ID);

        expect(matches.size).toBe(1);
        expect(matchAssistant.createMatchBasedOnType).toHaveBeenCalledTimes(1);
      });

      it("recreates a missing shell under the same id", async () => {
        await service.startDraft(CONFIRMATION_ID);
        const { matchId } = await state();
        matches.clear();
        await redis.del(getCaptainPickShellKey(CONFIRMATION_ID));

        await expect(service.ensureMatchShell(CONFIRMATION_ID)).resolves.toBe(
          true,
        );

        expect([...matches.keys()]).toEqual([matchId]);
      });

      it("reuses an existing correct shell", async () => {
        await service.startDraft(CONFIRMATION_ID);
        await redis.del(getCaptainPickShellKey(CONFIRMATION_ID));
        matchAssistant.createMatchBasedOnType.mockClear();

        await expect(service.ensureMatchShell(CONFIRMATION_ID)).resolves.toBe(
          true,
        );

        expect(matchAssistant.createMatchBasedOnType).not.toHaveBeenCalled();
        expect(matchAssistant.updateMatchStatus).not.toHaveBeenCalled();
      });

      it("never touches a foreign match under the id", async () => {
        await service.startDraft(CONFIRMATION_ID);
        const { matchId } = await state();
        const foreign = matches.get(matchId!)!;
        foreign.options.type = "Wingman";
        const before = structuredClone(foreign);
        await redis.del(getCaptainPickShellKey(CONFIRMATION_ID));
        matchAssistant.createMatchBasedOnType.mockClear();

        await expect(service.ensureMatchShell(CONFIRMATION_ID)).resolves.toBe(
          false,
        );

        expect(matches.get(matchId!)).toEqual(before);
        expect(matchAssistant.createMatchBasedOnType).not.toHaveBeenCalled();
        expect(matchAssistant.updateMatchStatus).not.toHaveBeenCalled();
        expect(hasura.mutation).not.toHaveBeenCalled();
        expect(await shellReady()).toBeNull();
      });
    });

    describe("picks", () => {
      it("manual picks keep the same match and never start it", async () => {
        await service.startDraft(CONFIRMATION_ID);
        const { matchId } = await state();

        await draftToCompletion();

        const s = await state();
        expect(s.phase).toBe("CreatingMatch");
        expect(s.matchId).toBe(matchId);
        expect(matches.size).toBe(1);
        expect(matchAssistant.createMatchBasedOnType).toHaveBeenCalledTimes(1);
        expect(matches.get(matchId!)!.status).toBe("PickingPlayers");
        expect(matchAssistant.updateMatchStatus).not.toHaveBeenCalled();
      });

      it("timeout picks, including the final auto-pick, keep the same match", async () => {
        await service.startDraft(CONFIRMATION_ID);
        const { matchId } = await state();

        for (let i = 0; i < 7; i++) {
          const current = await state();
          setNow(new Date(current.timer!.deadline).getTime());
          await service.handleTimeout(
            CONFIRMATION_ID,
            current.draft.pickIndex!,
            current.timer!.deadline,
          );
        }

        const s = await state();
        expect(s.phase).toBe("CreatingMatch");
        expect(s.matchId).toBe(matchId);
        expect(matches.size).toBe(1);
        expect(matchAssistant.createMatchBasedOnType).toHaveBeenCalledTimes(1);
      });
    });

    describe("finalization", () => {
      it("seats the drafted teams in the early match, then starts the normal veto", async () => {
        await service.startDraft(CONFIRMATION_ID);
        const { matchId } = await state();
        await draftToCompletion();
        const drafted = (await state()).draft;

        await service.finalize(CONFIRMATION_ID);

        expect(matches.size).toBe(1);
        expect(matchAssistant.createMatchBasedOnType).toHaveBeenCalledTimes(1);
        const match = matches.get(matchId!)!;
        for (const lineup of [1, 2] as const) {
          const seated = lineupPlayers.filter(
            (p) => p.match_lineup_id === match[`lineup_${lineup}_id`],
          );
          expect(seated.map((p) => p.steam_id).sort()).toEqual(
            [...drafted.lineups[lineup]].sort(),
          );
          expect(
            seated.filter((p) => p.captain).map((p) => p.steam_id),
          ).toEqual([drafted.captains[lineup].steam_id]);
        }
        expect(matchAssistant.updateMatchStatus).toHaveBeenCalledTimes(1);
        expect(matchAssistant.updateMatchStatus).toHaveBeenCalledWith(
          matchId,
          "Live",
        );
        expect(match.status).toBe("Veto");
        const s = await state();
        expect(s.phase).toBe("MatchCreated");
        expect(s.matchId).toBe(matchId);
        // Now the normal matchmaking routing may send everyone there.
        expect(
          redis.messagesTo(steam(1), "matchmaking:details").at(-1).data
            .confirmation.matchId,
        ).toBe(matchId);
      });

      it("still creates the match at the end if the shell never could be", async () => {
        await service.startDraft(CONFIRMATION_ID);
        const { matchId } = await state();
        await draftToCompletion();
        matches.clear();

        await service.finalize(CONFIRMATION_ID);

        expect([...matches.keys()]).toEqual([matchId]);
        expect((await state()).phase).toBe("MatchCreated");
      });
    });

    describe("match status for the match page", () => {
      it("tells whether a match is an active draft's match and who is in it", async () => {
        await service.startDraft(CONFIRMATION_ID);
        const { matchId } = await state();

        await expect(
          service.getMatchDraftStatus(matchId!, steam(7)),
        ).resolves.toEqual({ active: true, participant: true });
        await expect(
          service.getMatchDraftStatus(matchId!, "999"),
        ).resolves.toEqual({ active: true, participant: false });
        await expect(
          service.getMatchDraftStatus(matchId!, null),
        ).resolves.toEqual({ active: true, participant: false });
        await expect(
          service.getMatchDraftStatus("some-other-match", steam(7)),
        ).resolves.toEqual({ active: false, participant: false });
      });

      it("is no longer active once the match is created (no permanent lock)", async () => {
        await service.startDraft(CONFIRMATION_ID);
        const { matchId } = await state();
        await draftToCompletion();
        await expect(
          service.getMatchDraftStatus(matchId!, steam(7)),
        ).resolves.toEqual({ active: true, participant: true });

        await service.finalize(CONFIRMATION_ID);

        await expect(
          service.getMatchDraftStatus(matchId!, steam(7)),
        ).resolves.toEqual({ active: false, participant: false });
      });

      it("never trusts a mapping that points at another draft's match", async () => {
        await service.startDraft(CONFIRMATION_ID);
        await redis.set(
          getMatchConfirmationKey("forged-match"),
          CONFIRMATION_ID,
        );

        await expect(
          service.getMatchDraftStatus("forged-match", steam(7)),
        ).resolves.toEqual({ active: false, participant: false });
      });
    });

    describe("an admin canceling the match during picking", () => {
      const canceledByAdmin = (n: number) =>
        redis
          .messagesTo(steam(n), "matchmaking:error")
          .filter(
            (m) =>
              m.data.message ===
              "The Captain Pick match was canceled by an admin.",
          );

      it("tells the ten players why the draft ended", async () => {
        await service.startDraft(CONFIRMATION_ID);
        await pickNext();

        // What the end-of-match cleanup does for a canceled match.
        await service.cleanup(CONFIRMATION_ID);

        for (let n = 1; n <= 10; n++) {
          expect(canceledByAdmin(n)).toHaveLength(1);
          await expect(service.getActiveDraftId(steam(n))).resolves.toBeNull();
        }
      });

      it("says nothing of the kind when a finished match is cleaned up", async () => {
        await service.startDraft(CONFIRMATION_ID);
        await draftToCompletion();
        await service.finalize(CONFIRMATION_ID);

        await service.cleanup(CONFIRMATION_ID);

        for (let n = 1; n <= 10; n++) {
          expect(canceledByAdmin(n)).toHaveLength(0);
        }
      });

      it("keeps the failed-creation message separate", async () => {
        await service.startDraft(CONFIRMATION_ID);
        await draftToCompletion();
        matches.clear();

        await service.handleFinalizeExhausted(
          CONFIRMATION_ID,
          new Error("boom"),
        );

        for (let n = 1; n <= 10; n++) {
          expect(canceledByAdmin(n)).toHaveLength(0);
        }
      });
    });

    describe("failure", () => {
      it("cancels the shell and removes its mappings when the draft is released", async () => {
        await service.startDraft(CONFIRMATION_ID);
        const { matchId } = await state();
        await draftToCompletion();
        failNextLineupInsert = true;

        await new CaptainPickFinalize(service).process({
          data: { confirmationId: CONFIRMATION_ID },
          opts: { attempts: CAPTAIN_PICK_FINALIZE_ATTEMPTS },
          attemptsMade: CAPTAIN_PICK_FINALIZE_ATTEMPTS - 1,
        } as any);

        expect(matches.get(matchId!)!.status).toBe("Canceled");
        expect(await mapping(matchId!)).toBeNull();
        expect(await shellReady()).toBeNull();
        expect(await service.hasDraft(CONFIRMATION_ID)).toBe(false);
      });

      it("only removes its own mapping", async () => {
        await service.startDraft(CONFIRMATION_ID);
        const { matchId } = await state();
        await redis.set(getMatchConfirmationKey(matchId!), "someone-else");

        await service.cleanup(CONFIRMATION_ID);

        expect(await mapping(matchId!)).toBe("someone-else");
      });
    });
  });

  describe("recovering from failed match creation", () => {
    const exhaust = () =>
      service.handleFinalizeExhausted(CONFIRMATION_ID, new Error("boom"));
    const createFailureMessages = (n: number) =>
      redis
        .messagesTo(steam(n), "matchmaking:error")
        .filter(
          (m) =>
            m.data.message ===
            "The Captain Pick match could not be created. Please queue again.",
        );
    const onlyMatch = () => [...matches.values()][0];

    beforeEach(async () => {
      await service.startDraft(CONFIRMATION_ID);
      await draftToCompletion();
    });

    describe("no match row exists", () => {
      // The early shell could never be created (e.g. Postgres down all along).
      beforeEach(() => {
        matches.clear();
      });

      it("releases everyone with the queue-again message, no requeue, no penalty", async () => {
        await exhaust();

        expect(matches.size).toBe(0);
        expect(await service.hasDraft(CONFIRMATION_ID)).toBe(false);
        for (let n = 1; n <= 10; n++) {
          await expect(service.getActiveDraftId(steam(n))).resolves.toBeNull();
          expect(createFailureMessages(n)).toHaveLength(1);
        }
        // Nothing queued back and nothing written besides the failure.
        expect(queue.byName("CaptainPickFinalize")).toHaveLength(1);
        expect(hasura.mutation).not.toHaveBeenCalled();
        expect(
          redis.hashes.has(getMatchmakingConformationCacheKey(CONFIRMATION_ID)),
        ).toBe(false);
      });

      it("is safe to run twice", async () => {
        await exhaust();
        await exhaust();

        for (let n = 1; n <= 10; n++) {
          expect(createFailureMessages(n)).toHaveLength(1);
        }
      });
    });

    describe("a complete match already exists (Redis never heard)", () => {
      beforeEach(async () => {
        // The DB side fully succeeded, then the process died before Redis
        // recorded anything.
        const s = await state();
        const recordSpy = jest
          .spyOn(service as any, "recordMatchCreated")
          .mockRejectedValueOnce(new Error("redis gone"));
        await expect(service.finalize(CONFIRMATION_ID)).rejects.toThrow(
          "redis gone",
        );
        recordSpy.mockRestore();
        expect(matches.get(s.matchId!)?.status).toBe("Veto");
        expect((await state()).phase).toBe("CreatingMatch");
      });

      it("a plain retry recovers it without a second match", async () => {
        await service.finalize(CONFIRMATION_ID);

        expect(matchAssistant.createMatchBasedOnType).toHaveBeenCalledTimes(1);
        expect(matches.size).toBe(1);
        expect((await state()).phase).toBe("MatchCreated");
      });

      it("the terminal path recovers it as the match instead of failing", async () => {
        await exhaust();

        const s = await state();
        expect(s.phase).toBe("MatchCreated");
        expect(onlyMatch().status).toBe("Veto");
        expect(matches.size).toBe(1);
        expect(
          await redis.hget(
            getMatchmakingConformationCacheKey(CONFIRMATION_ID),
            "matchId",
          ),
        ).toBe(s.matchId);
        for (let n = 1; n <= 10; n++) {
          // Still committed to that match; never told to queue again.
          await expect(service.getActiveDraftId(steam(n))).resolves.toBe(
            CONFIRMATION_ID,
          );
          expect(createFailureMessages(n)).toHaveLength(0);
        }
        expect(matchAssistant.updateMatchStatus).not.toHaveBeenCalledWith(
          s.matchId,
          "Canceled",
        );
      });

      it("keeps the drafted captains and normal veto when recovering", async () => {
        const s = await state();
        // A captain flag lost somewhere is restored, not a reason to cancel.
        for (const p of lineupPlayers) {
          p.captain = false;
        }

        await exhaust();

        const match = onlyMatch();
        expect(match.options.type).toBe("Competitive");
        expect(match.options.map_veto).toBe(true);
        expect(match.options.map_pool.type).toBe("Competitive");
        for (const [lineup, lineupId] of [
          [1, match.lineup_1_id],
          [2, match.lineup_2_id],
        ] as const) {
          expect(
            lineupPlayers
              .filter((p) => p.match_lineup_id === lineupId && p.captain)
              .map((p) => p.steam_id),
          ).toEqual([s.draft.captains[lineup].steam_id]);
        }
      });

      it("recovering twice is harmless", async () => {
        await exhaust();
        await exhaust();
        await service.finalize(CONFIRMATION_ID);

        expect((await state()).phase).toBe("MatchCreated");
        expect(matches.size).toBe(1);
        expect(onlyMatch().status).toBe("Veto");
      });

      it("never cancels a match that already finished", async () => {
        onlyMatch().status = "Finished";

        await exhaust();

        expect(onlyMatch().status).toBe("Finished");
        expect((await state()).phase).toBe("MatchCreated");
      });
    });

    describe("a partial match exists", () => {
      it("is detected as partial when lineups are missing", async () => {
        failNextLineupInsert = true;
        await expect(service.finalize(CONFIRMATION_ID)).rejects.toThrow();

        const inspection = await service.inspectMatch(await state());
        expect(inspection).toMatchObject({
          kind: "partial",
          lineupsComplete: false,
        });
      });

      it("is detected as partial when it was never started", async () => {
        failStatus.Live = "No game servers are available in region Europe";
        await expect(service.finalize(CONFIRMATION_ID)).rejects.toThrow(
          /No game servers/,
        );

        const inspection = await service.inspectMatch(await state());
        expect(inspection).toMatchObject({
          kind: "partial",
          lineupsComplete: true,
          reason: "match was never started",
        });
      });

      it("is canceled before anyone is released, and can never start", async () => {
        failStatus.Live = "No game servers are available in region Europe";
        await expect(service.finalize(CONFIRMATION_ID)).rejects.toThrow();

        const order: string[] = [];
        matchAssistant.updateMatchStatus.mockImplementation(
          async (id: string, status: string) => {
            order.push(`status:${status}`);
            matches.get(id).status = status;
          },
        );
        const originalPublish = redis.publish.bind(redis);
        jest
          .spyOn(redis, "publish")
          .mockImplementation(async (channel: string, message: string) => {
            if (JSON.parse(message).event === "matchmaking:error") {
              order.push("released");
            }
            return originalPublish(channel, message);
          });

        await exhaust();

        expect(order[0]).toBe("status:Canceled");
        expect(order.slice(1).every((step) => step === "released")).toBe(true);
        expect(onlyMatch().status).toBe("Canceled");
        // Canceled and never set Live again by Captain Pick.
        expect(order).not.toContain("status:Live");

        // The finalizer no longer acts on it at all.
        await service.finalize(CONFIRMATION_ID);
        expect(onlyMatch().status).toBe("Canceled");
      });

      it("cleanup is idempotent", async () => {
        failNextLineupInsert = true;
        await expect(service.finalize(CONFIRMATION_ID)).rejects.toThrow();

        await exhaust();
        await exhaust();

        expect(onlyMatch().status).toBe("Canceled");
        for (let n = 1; n <= 10; n++) {
          expect(createFailureMessages(n)).toHaveLength(1);
        }
      });

      it("a failing cancel keeps everyone committed and retries later", async () => {
        failNextLineupInsert = true;
        await expect(service.finalize(CONFIRMATION_ID)).rejects.toThrow();
        failStatus.Canceled = "hasura unavailable";

        await exhaust();

        expect(onlyMatch().status).toBe("PickingPlayers");
        expect((await state()).phase).toBe("CreatingMatch");
        for (let n = 1; n <= 10; n++) {
          await expect(service.getActiveDraftId(steam(n))).resolves.toBe(
            CONFIRMATION_ID,
          );
          expect(createFailureMessages(n)).toHaveLength(0);
        }
        const [recovery] = queue.added.filter((j) => j.data.recovery);
        expect(recovery.opts.delay).toBe(60000);

        // Once cancel works again, the recovery job finishes the job.
        delete failStatus.Canceled;
        await new CaptainPickFinalize(service).process({
          data: recovery.data,
          opts: recovery.opts,
          attemptsMade: 0,
        } as any);

        expect(onlyMatch().status).toBe("Canceled");
        expect(await service.getActiveDraftId(steam(1))).toBeNull();
      });
    });

    describe("a match that isn't this draft's", () => {
      it("is left alone and nobody is released", async () => {
        const s = await state();
        matches.set(
          s.matchId!,
          matchRow("Wingman", "Wingman", {
            id: s.matchId,
            region: REGION,
            mr: 8,
            best_of: 1,
            knife: true,
            overtime: true,
            timeout_setting: "CoachAndPlayers",
          }),
        );

        await exhaust();

        expect(onlyMatch().status).toBe("PickingPlayers");
        expect(matchAssistant.updateMatchStatus).not.toHaveBeenCalled();
        expect(await service.getActiveDraftId(steam(1))).toBe(CONFIRMATION_ID);
        expect(queue.added.filter((j) => j.data.recovery)).toHaveLength(1);
      });

      it("a draft-linked match is never treated as ours", async () => {
        failNextLineupInsert = true;
        await expect(service.finalize(CONFIRMATION_ID)).rejects.toThrow();
        onlyMatch().draft_games = [{ id: "draft-game" }];

        expect((await service.inspectMatch(await state())).kind).toBe(
          "foreign",
        );
      });
    });

    it("two finalize workers racing create one match", async () => {
      const results = await Promise.allSettled([
        service.finalize(CONFIRMATION_ID),
        service.finalize(CONFIRMATION_ID),
      ]);

      expect(results.filter((r) => r.status === "fulfilled")).not.toHaveLength(
        0,
      );
      expect(matchAssistant.createMatchBasedOnType).toHaveBeenCalledTimes(1);
      expect(matches.size).toBe(1);
      expect((await state()).phase).toBe("MatchCreated");
    });

    it("never generates a new match id on retry", async () => {
      const { matchId } = await state();
      failNextLineupInsert = true;
      await expect(service.finalize(CONFIRMATION_ID)).rejects.toThrow();
      await service.finalize(CONFIRMATION_ID);

      expect((await state()).matchId).toBe(matchId);
      expect([...matches.keys()]).toEqual([matchId]);
    });
  });

  describe("public state and cleanup", () => {
    beforeEach(async () => {
      await service.startDraft(CONFIRMATION_ID);
    });

    it("exposes only what the web needs", async () => {
      const publicState = service.toPublicState(await state());

      expect(Object.keys(publicState).sort()).toEqual(
        [
          "available",
          "captains",
          "deadline",
          "draftId",
          "firstPickLineup",
          "firstPickReason",
          "lineups",
          "matchId",
          "participants",
          "phase",
          "pickIndex",
          "pickOrder",
          "pickingCaptainSteamId",
          "pickingLineup",
          "picks",
          "region",
          "serverNow",
          "timerSeconds",
        ].sort(),
      );
      expect(Object.keys(publicState.participants[0]).sort()).toEqual([
        "avatar_url",
        "elo",
        "name",
        "steam_id",
      ]);
    });

    it("sends a reconnecting player the same deadline", async () => {
      const deadline = (await state()).timer!.deadline;
      setNow(START + 12000);

      await service.publishState(CONFIRMATION_ID, [steam(4)]);

      const [first, reconnect] = redis.messagesTo(
        steam(4),
        "matchmaking:details",
      );
      expect(first.data.confirmation.captainPick.deadline).toBe(deadline);
      expect(reconnect.data.confirmation.captainPick.deadline).toBe(deadline);
      expect(reconnect.data.confirmation.captainPick.serverNow).toBe(
        new Date(START + 12000).toISOString(),
      );
      expect(redis.messagesTo(steam(5), "matchmaking:details")).toHaveLength(1);
    });

    it("cleans up the draft and only the reverse keys still pointing at it", async () => {
      await redis.set(getCaptainPickPlayerCacheKey(steam(3)), "other-draft");

      await service.cleanup(CONFIRMATION_ID);

      expect(await service.hasDraft(CONFIRMATION_ID)).toBe(false);
      expect(await service.getActiveDraftId(steam(1))).toBeNull();
      expect(await redis.get(getCaptainPickPlayerCacheKey(steam(3)))).toBe(
        "other-draft",
      );

      // Released players get the usual "no longer in matchmaking" update;
      // the one now in another draft does not.
      expect(
        redis.messagesTo(steam(1), "matchmaking:details").at(-1).data,
      ).toEqual({});
      expect(
        redis
          .messagesTo(steam(3), "matchmaking:details")
          .filter((message) => Object.keys(message.data).length === 0),
      ).toHaveLength(0);
    });
  });
});
