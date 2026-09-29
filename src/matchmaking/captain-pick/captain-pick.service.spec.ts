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
  getCaptainPickTimeoutJobId,
} from "./captain-pick.service";
import { getPickingLineup } from "./captain-pick-rules";
import {
  getCaptainPickDraftCacheKey,
  getCaptainPickPlayerCacheKey,
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
  lineup_1_id: string;
  lineup_2_id: string;
};

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
          return {
            matches_by_pk: matches.get(query.matches_by_pk.__args.id) ?? null,
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
      createMatchBasedOnType: jest.fn(async (_type, _pool, options) => {
        if (matches.has(options.id)) {
          throw new Error("duplicate key value violates matches_pkey");
        }
        const match = {
          id: options.id,
          status: "PickingPlayers",
          lineup_1_id: `${options.id}-lineup-1`,
          lineup_2_id: `${options.id}-lineup-2`,
        };
        matches.set(options.id, match);
        return match;
      }),
      // tbu_matches: Live without a map becomes the normal map veto.
      updateMatchStatus: jest.fn(async (id: string, status: string) => {
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
          matchId: null,
        });
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
        async (_t, _p, options) => {
          matches.set(options.id, {
            id: options.id,
            status: "PickingPlayers",
            lineup_1_id: `${options.id}-lineup-1`,
            lineup_2_id: `${options.id}-lineup-2`,
          });
          throw new Error("duplicate key value violates matches_pkey");
        },
      );

      await service.finalize(CONFIRMATION_ID);

      expect(matches.size).toBe(1);
      expect(matches.has(s.matchId!)).toBe(true);
      expect((await state()).phase).toBe("MatchCreated");
    });

    it("refuses to run twice at the same time", async () => {
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

      it("releases everyone (no requeue, no penalty) after the last attempt", async () => {
        failNextLineupInsert = true;

        await new CaptainPickFinalize(service).process(
          job(CAPTAIN_PICK_FINALIZE_ATTEMPTS - 1),
        );

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

        await expect(
          new CaptainPickFinalize(service).process(
            job(CAPTAIN_PICK_FINALIZE_ATTEMPTS - 1),
          ),
        ).rejects.toBeInstanceOf(CaptainPickFinalizeBusyError);
        expect((await state()).phase).toBe("CreatingMatch");
      });
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
      expect(await service.getActiveDraftId(steam(3))).toBe("other-draft");

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
