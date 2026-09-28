import {
  isEligibleForTeamGeneration,
  selectTeamGenerationPool,
  TournamentTeamGenerationService,
} from "./tournament-team-generation.service";

// Solo Random team generation: attendance is required. Only a checked-in
// Registered or Waitlisted signup may be placed on a team, the CURRENT
// first-stage max_teams decides capacity, and registration priority
// (created_at) decides who gets the seats before ELO balancing.
//
// The Hasura stub deliberately ignores the query's `where` and returns every
// signup of the tournament, whatever its status, so these tests prove the
// service's own eligibility rule rather than a filter the stub applied.

type Signup = {
  id: string;
  player_steam_id: string;
  status: string;
  checked_in_at: string | null;
  created_at: string;
  player: { name: string; elo: { competitive: number; wingman: number } };
};

const CHECKED_IN = "2026-09-28T17:30:00Z";
const BASE = Date.parse("2026-09-20T12:00:00Z");

let seq = 0;
const signup = (
  status: string,
  checkedIn: boolean,
  overrides: Partial<Signup> & { elo?: number } = {},
): Signup => {
  seq++;
  const { elo = 5000, ...rest } = overrides;
  return {
    id: `signup-${seq}`,
    player_steam_id: String(76561190000000000n + BigInt(seq)),
    status,
    checked_in_at: checkedIn ? CHECKED_IN : null,
    // Strictly increasing registration time in creation order.
    created_at: new Date(BASE + seq * 1000).toISOString(),
    player: { name: `p${seq}`, elo: { competitive: elo, wingman: elo } },
    ...rest,
  };
};
const many = (n: number, status: string, checkedIn: boolean) =>
  Array.from({ length: n }, () => signup(status, checkedIn));

// Records what the generation transaction writes.
const makeService = (signups: Array<Signup>, maxTeams: number | null) => {
  const rosterSteamIds: Array<string> = [];
  const assignedSignupIds: Array<string> = [];
  const waitlistedSignupIds: Array<string> = [];
  let teamsInserted = 0;
  let existingTeams = 0;

  const client = {
    query: jest.fn(async (sql: string, params: Array<any> = []) => {
      if (sql.includes("COUNT(*)")) {
        return { rows: [{ count: existingTeams }] };
      }
      if (sql.includes("INSERT INTO public.tournament_teams")) {
        teamsInserted++;
        return { rows: [{ id: `team-${teamsInserted}` }] };
      }
      if (sql.includes("INSERT INTO public.tournament_team_roster")) {
        rosterSteamIds.push(params[1]);
        return { rows: [] };
      }
      if (sql.includes("SET status = 'Assigned'")) {
        assignedSignupIds.push(params[1]);
        return { rows: [] };
      }
      if (sql.includes("SET status = 'Waitlisted'")) {
        waitlistedSignupIds.push(...params[0]);
        return { rows: [] };
      }
      if (sql.includes("FROM public.tournament_stages")) {
        return { rows: [{ id: "stage-1" }] };
      }
      return { rows: [] };
    }),
  };

  const postgres = {
    query: jest.fn(async (sql: string) => {
      if (sql.includes("COUNT(*)")) {
        return [{ count: existingTeams }];
      }
      if (sql.includes("SELECT max_teams")) {
        return maxTeams == null ? [] : [{ max_teams: maxTeams }];
      }
      return [];
    }),
    transaction: jest.fn(async (fn: (c: typeof client) => Promise<void>) => {
      await fn(client);
      existingTeams = teamsInserted;
    }),
  };

  const hasura = {
    query: jest.fn(async () => ({ tournament_individual_signups: signups })),
  };

  const service = new TournamentTeamGenerationService(
    { log: jest.fn(), error: jest.fn(), warn: jest.fn() } as never,
    hasura as never,
    postgres as never,
  );

  return {
    service,
    hasura,
    written: {
      rosterSteamIds,
      assignedSignupIds,
      waitlistedSignupIds,
      teams: () => teamsInserted,
    },
  };
};

const steamIdsOf = (rows: Array<Signup>) =>
  rows.map((row) => row.player_steam_id);

describe("isEligibleForTeamGeneration", () => {
  it.each([
    ["Registered", true, true],
    ["Registered", false, false],
    ["Waitlisted", true, true],
    ["Waitlisted", false, false],
    ["Removed", true, false],
    ["Removed", false, false],
    ["Assigned", true, false],
  ])("%s checked-in=%s => %s", (status, checkedIn, expected) => {
    expect(
      isEligibleForTeamGeneration({
        status,
        checked_in_at: checkedIn ? CHECKED_IN : null,
      }),
    ).toBe(expected);
  });
});

describe("selectTeamGenerationPool", () => {
  it("caps at min(current max_teams, headcount teams) and keeps priority order", () => {
    const pool = many(12, "Registered", true).reverse();
    const result = selectTeamGenerationPool(pool, 5, 8);
    expect(result.teamCount).toBe(2);
    expect(result.selected).toHaveLength(10);
    expect(result.overflow).toHaveLength(2);
    // Earliest created_at first, regardless of input order.
    const times = result.selected.map((s) => Date.parse(s.created_at));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it("no configured max_teams falls back to headcount", () => {
    expect(
      selectTeamGenerationPool(many(11, "Registered", true), 5, null).teamCount,
    ).toBe(2);
  });
});

describe("TournamentTeamGenerationService.generateTournamentTeamsForTournament", () => {
  it("A) 44 signups, 39 checked in, max 8, 5v5 => 7 teams, 35 Assigned, 4 sit out, no unchecked player assigned", async () => {
    // 35 Registered + 4 Waitlisted checked in, 5 unchecked Registered
    // spread through the priority order (some sign up early).
    const uncheckedEarly = many(3, "Registered", false);
    const checkedA = many(20, "Registered", true);
    const uncheckedLate = many(2, "Registered", false);
    const checkedB = many(15, "Registered", true);
    const checkedWaitlisted = many(4, "Waitlisted", true);
    const all = [
      ...uncheckedEarly,
      ...checkedA,
      ...uncheckedLate,
      ...checkedB,
      ...checkedWaitlisted,
    ];
    expect(all).toHaveLength(44);

    const { service, written } = makeService(all, 8);
    const result = await service.generateTournamentTeamsForTournament("t", 5);

    expect(result).toEqual({ teamsCreated: 7, waitlisted: 4 });
    expect(written.teams()).toBe(7);
    expect(written.assignedSignupIds).toHaveLength(35);
    expect(written.rosterSteamIds).toHaveLength(35);
    // The 4 latest checked-in signups sit out, still Waitlisted.
    expect(written.waitlistedSignupIds).toHaveLength(4);
    expect(new Set(written.waitlistedSignupIds)).toEqual(
      new Set(checkedWaitlisted.map((s) => s.id)),
    );

    const unchecked = [...uncheckedEarly, ...uncheckedLate];
    for (const s of unchecked) {
      expect(written.assignedSignupIds).not.toContain(s.id);
      expect(written.rosterSteamIds).not.toContain(s.player_steam_id);
      expect(written.waitlistedSignupIds).not.toContain(s.id);
    }
  });

  it("B) 40 checked in, max 8, 5v5 => 8 teams, 40 Assigned, nobody sits out", async () => {
    const all = [
      ...many(35, "Registered", true),
      ...many(5, "Waitlisted", true),
    ];
    const { service, written } = makeService(all, 8);
    const result = await service.generateTournamentTeamsForTournament("t", 5);

    expect(result).toEqual({ teamsCreated: 8, waitlisted: 0 });
    expect(written.assignedSignupIds).toHaveLength(40);
    expect(written.waitlistedSignupIds).toHaveLength(0);
  });

  it("C) stale cap: waitlisted under max 7, all 40 checked in, max raised to 8 => 8 teams, all 40 assigned", async () => {
    // Waitlisted at sign-up time because max 7 * 5 = 35 was full then.
    const registered = many(35, "Registered", true);
    const waitlisted = many(5, "Waitlisted", true);
    // Generation reads the CURRENT max_teams (8), not the old cap.
    const { service, written } = makeService(
      [...registered, ...waitlisted],
      8,
    );
    const result = await service.generateTournamentTeamsForTournament("t", 5);

    expect(result.teamsCreated).toBe(8);
    expect(written.assignedSignupIds).toHaveLength(40);
    for (const s of waitlisted) {
      expect(written.rosterSteamIds).toContain(s.player_steam_id);
    }
  });

  it("E) an unchecked Waitlisted player is never assigned, even with room to spare", async () => {
    const uncheckedWaitlisted = signup("Waitlisted", false);
    const all = [...many(10, "Registered", true), uncheckedWaitlisted];
    const { service, written } = makeService(all, 8);
    await service.generateTournamentTeamsForTournament("t", 5);

    expect(written.rosterSteamIds).not.toContain(
      uncheckedWaitlisted.player_steam_id,
    );
    expect(written.assignedSignupIds).not.toContain(uncheckedWaitlisted.id);
  });

  it("F) an unchecked Registered player is never assigned, even the earliest signup", async () => {
    const uncheckedRegistered = signup("Registered", false);
    const all = [uncheckedRegistered, ...many(10, "Registered", true)];
    const { service, written } = makeService(all, 8);
    const result = await service.generateTournamentTeamsForTournament("t", 5);

    expect(result.teamsCreated).toBe(2);
    expect(written.rosterSteamIds).not.toContain(
      uncheckedRegistered.player_steam_id,
    );
  });

  it("never selects Removed or already Assigned signups", async () => {
    const removed = signup("Removed", true);
    const assigned = signup("Assigned", true);
    const all = [removed, assigned, ...many(5, "Registered", true)];
    const { service, written } = makeService(all, 8);
    await service.generateTournamentTeamsForTournament("t", 5);

    expect(written.assignedSignupIds).not.toContain(removed.id);
    expect(written.assignedSignupIds).not.toContain(assigned.id);
    expect(written.assignedSignupIds).toHaveLength(5);
  });

  it("G) priority: earliest created_at gets the seats, a later high-ELO signup cannot bump them", async () => {
    const early = Array.from({ length: 10 }, (_, i) =>
      signup(i % 2 ? "Registered" : "Waitlisted", true, { elo: 100 }),
    );
    const lateStar = signup("Registered", true, { elo: 30000 });
    // Input order scrambled on purpose.
    const { service, written } = makeService([lateStar, ...early].reverse(), 2);
    const result = await service.generateTournamentTeamsForTournament("t", 5);

    expect(result).toEqual({ teamsCreated: 2, waitlisted: 1 });
    expect(new Set(written.rosterSteamIds)).toEqual(
      new Set(steamIdsOf(early)),
    );
    expect(written.waitlistedSignupIds).toEqual([lateStar.id]);
  });

  it("throws when nobody has checked in", async () => {
    const { service, written } = makeService(many(10, "Registered", false), 8);
    await expect(
      service.generateTournamentTeamsForTournament("t", 5),
    ).rejects.toThrow(/checked-in/);
    expect(written.teams()).toBe(0);
  });

  it("asks Hasura only for checked-in Registered/Waitlisted signups", async () => {
    const { service, hasura } = makeService(many(5, "Registered", true), 8);
    await service.generateTournamentTeamsForTournament("t", 5);
    const where = (hasura.query.mock.calls[0] as Array<any>)[0]
      .tournament_individual_signups.__args.where;
    expect(where).toEqual({
      tournament_id: { _eq: "t" },
      status: { _in: ["Registered", "Waitlisted"] },
      checked_in_at: { _is_null: false },
    });
  });

  it("I) idempotent: a second call is a clean no-op", async () => {
    const { service, written } = makeService(many(10, "Registered", true), 8);
    const first = await service.generateTournamentTeamsForTournament("t", 5);
    expect(first.teamsCreated).toBe(2);

    const second = await service.generateTournamentTeamsForTournament("t", 5);
    expect(second).toEqual({ teamsCreated: 0, waitlisted: 0 });
    expect(written.teams()).toBe(2);
    expect(written.assignedSignupIds).toHaveLength(10);
  });
});
