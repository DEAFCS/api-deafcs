import { PostgresService } from "./../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import {
  bootMigratedDb,
  seedRegionWithServer,
  SqlTestDb,
} from "./utils/sql-test-db";

// Exercises the map veto SQL: get_map_veto_pattern / get_map_veto_type /
// get_map_veto_picking_lineup_id, verify_map_veto_pick enforcement, and
// create_match_map_from_veto (map materialization, side assignment, the
// auto-inserted Decider, and going Live when the veto completes).
describe("map veto (SQL-driven)", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;

  beforeAll(async () => {
    db = await bootMigratedDb("MapVetoTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres);
    await seedRegionWithServer(postgres, "TestA");
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await postgres.query("DELETE FROM matches");
    await postgres.query("DELETE FROM match_options");
  });

  // A match sitting in Veto: single viable region (pre-selected on insert) so
  // only the map veto is outstanding when we push it towards Live.
  const createVetoMatch = async (bestOf: number, poolSize: number) => {
    const { poolId, mapIds } = await fx.mapPool(poolSize);
    const match = await fx.match({ bestOf, mapVeto: true, mapPoolId: poolId });
    // tbu_matches redirects Live to Veto while maps are missing.
    await postgres.query("UPDATE matches SET status = 'Live' WHERE id = $1", [
      match.id,
    ]);
    return { ...match, mapIds };
  };

  const vetoState = async (matchId: string) => {
    const [row] = await postgres.query<
      Array<{ status: string; veto_type: string | null; picking: string | null }>
    >(
      `SELECT m.status, get_map_veto_type(m) AS veto_type,
              get_map_veto_picking_lineup_id(m) AS picking
       FROM matches m WHERE m.id = $1`,
      [matchId],
    );
    return row;
  };

  const insertPick = (
    matchId: string,
    type: string,
    lineupId: string,
    mapId: string,
    side: string | null = null,
  ) =>
    postgres.query(
      `INSERT INTO match_map_veto_picks (match_id, type, match_lineup_id, map_id, side)
       VALUES ($1, $2, $3, $4, $5)`,
      [matchId, type, lineupId, mapId, side],
    );

  it("computes the CS rulebook patterns", async () => {
    const bo1 = await createVetoMatch(1, 3);
    const [{ pattern: p1 }] = await postgres.query<
      Array<{ pattern: string[] }>
    >("SELECT get_map_veto_pattern(m) AS pattern FROM matches m WHERE id = $1", [
      bo1.id,
    ]);
    expect(p1).toEqual(["Ban", "Ban", "Decider"]);

    const bo3 = await createVetoMatch(3, 4);
    const [{ pattern: p3 }] = await postgres.query<
      Array<{ pattern: string[] }>
    >("SELECT get_map_veto_pattern(m) AS pattern FROM matches m WHERE id = $1", [
      bo3.id,
    ]);
    expect(p3).toEqual(["Ban", "Pick", "Side", "Pick", "Side", "Decider"]);
  });

  it("enforces type, turn, side, and pool membership", async () => {
    const match = await createVetoMatch(1, 3);

    const state = await vetoState(match.id);
    expect(state.status).toBe("Veto");
    expect(state.veto_type).toBe("Ban");
    expect(state.picking).toBe(match.lineup_1_id);

    // Wrong type for the current step.
    await expect(
      insertPick(match.id, "Pick", match.lineup_1_id, match.mapIds[0]),
    ).rejects.toThrow(/Expected pick type of Ban/i);

    // Wrong lineup for the current turn.
    await expect(
      insertPick(match.id, "Ban", match.lineup_2_id, match.mapIds[0]),
    ).rejects.toThrow(/Expected other lineup/i);

    // A Ban must not carry a side.
    await expect(
      insertPick(match.id, "Ban", match.lineup_1_id, match.mapIds[0], "CT"),
    ).rejects.toThrow(/Cannot Ban and choose side/i);

    // Maps outside the match's pool are not pickable.
    const [foreignMap] = await postgres.query<Array<{ id: string }>>(
      "SELECT id FROM maps WHERE type = 'Wingman' LIMIT 1",
    );
    await expect(
      insertPick(match.id, "Ban", match.lineup_1_id, foreignMap.id),
    ).rejects.toThrow(/Map not available/i);
  });

  it("rejects picks while no veto is in progress", async () => {
    const { poolId, mapIds } = await fx.mapPool(3);
    const match = await fx.match({ mapVeto: true, mapPoolId: poolId });

    // Still PickingPlayers: no veto type, no picking lineup, and the DB
    // itself rejects the pick (previously the NULL step slipped through
    // every comparison and only the Hasura permission function stood in
    // the way).
    const state = await vetoState(match.id);
    expect(state.veto_type).toBeNull();
    expect(state.picking).toBeNull();

    await expect(
      insertPick(match.id, "Ban", match.lineup_1_id, mapIds[0]),
    ).rejects.toThrow(/No map veto in progress/i);

    const [{ allowed }] = await postgres.query<
      Array<{ allowed: boolean | null }>
    >(
      `SELECT lineup_is_picking_map_veto(ml) AS allowed
       FROM match_lineups ml WHERE ml.id = $1`,
      [match.lineup_1_id],
    );
    // NULL (no active step) — Hasura treats anything but true as denied.
    expect(allowed).toBeFalsy();
  });

  it("runs a BO1 veto: alternating bans, auto-Decider, map materialized, match Live", async () => {
    const match = await createVetoMatch(1, 3);

    await insertPick(match.id, "Ban", match.lineup_1_id, match.mapIds[0]);
    expect((await vetoState(match.id)).picking).toBe(match.lineup_2_id);

    await insertPick(match.id, "Ban", match.lineup_2_id, match.mapIds[1]);

    const picks = await postgres.query<Array<{ type: string; map_id: string }>>(
      "SELECT type, map_id FROM match_map_veto_picks WHERE match_id = $1 ORDER BY created_at",
      [match.id],
    );
    expect(picks.map((p) => p.type)).toEqual(["Ban", "Ban", "Decider"]);
    expect(picks[2].map_id).toBe(match.mapIds[2]);

    const maps = await postgres.query<
      Array<{ map_id: string; order: number }>
    >('SELECT map_id, "order" FROM match_maps WHERE match_id = $1', [match.id]);
    expect(maps.length).toBe(1);
    expect(maps[0].map_id).toBe(match.mapIds[2]);

    expect((await vetoState(match.id)).status).toBe("Live");
  });

  it("orders the auto-Decider strictly after the ban that triggered it", async () => {
    // The Decider is inserted by create_match_map_from_veto inside the SAME
    // transaction as the final ban. Taking the created_at default (now(), frozen
    // at transaction start) tied it with that ban, and since the veto display
    // sorts on created_at with no tiebreaker the Decider could render before the
    // ban ("ban, ..., decider, ban"). It now uses clock_timestamp() so it always
    // sorts last. Assert strict ordering (a tie would fail this).
    const match = await createVetoMatch(1, 3);

    await insertPick(match.id, "Ban", match.lineup_1_id, match.mapIds[0]);
    await insertPick(match.id, "Ban", match.lineup_2_id, match.mapIds[1]);

    const [row] = await postgres.query<
      Array<{ last_ban: string; decider: string }>
    >(
      `SELECT max(created_at) FILTER (WHERE type = 'Ban')     AS last_ban,
              max(created_at) FILTER (WHERE type = 'Decider') AS decider
       FROM match_map_veto_picks WHERE match_id = $1`,
      [match.id],
    );

    expect(new Date(row.decider).getTime()).toBeGreaterThan(
      new Date(row.last_ban).getTime(),
    );
  });

  it("runs the BO3 Pick/Side steps and assigns the chosen side to the picking lineup", async () => {
    const match = await createVetoMatch(3, 4);

    // Step 1: Ban (lineup 1 opens).
    await insertPick(match.id, "Ban", match.lineup_1_id, match.mapIds[0]);

    // Step 2: Pick — follow whoever the SQL says is up.
    let state = await vetoState(match.id);
    expect(state.veto_type).toBe("Pick");
    const picker = state.picking!;
    await insertPick(match.id, "Pick", picker, match.mapIds[1]);

    // A Pick alone creates no map: the opposing side choice completes it.
    let maps = await postgres.query<Array<{ id: string }>>(
      "SELECT id FROM match_maps WHERE match_id = $1",
      [match.id],
    );
    expect(maps.length).toBe(0);

    // Step 3: Side — must be the other lineup, and a side is mandatory.
    state = await vetoState(match.id);
    expect(state.veto_type).toBe("Side");
    const sider =
      picker === match.lineup_1_id ? match.lineup_2_id : match.lineup_1_id;
    expect(state.picking).toBe(sider);

    await expect(
      insertPick(match.id, "Side", sider, match.mapIds[1]),
    ).rejects.toThrow(/Must pick a side/i);

    await insertPick(match.id, "Side", sider, match.mapIds[1], "CT");

    const [map] = await postgres.query<
      Array<{ map_id: string; lineup_1_side: string; lineup_2_side: string }>
    >(
      "SELECT map_id, lineup_1_side, lineup_2_side FROM match_maps WHERE match_id = $1",
      [match.id],
    );
    expect(map.map_id).toBe(match.mapIds[1]);
    // The side chooser gets the side they asked for.
    if (sider === match.lineup_1_id) {
      expect(map.lineup_1_side).toBe("CT");
      expect(map.lineup_2_side).toBe("TERRORIST");
    } else {
      expect(map.lineup_2_side).toBe("CT");
      expect(map.lineup_1_side).toBe("TERRORIST");
    }
  });

  it("deleting a veto pick removes the map it created", async () => {
    const match = await createVetoMatch(3, 4);

    await insertPick(match.id, "Ban", match.lineup_1_id, match.mapIds[0]);
    const picker = (await vetoState(match.id)).picking!;
    await insertPick(match.id, "Pick", picker, match.mapIds[1]);
    const sider =
      picker === match.lineup_1_id ? match.lineup_2_id : match.lineup_1_id;
    await insertPick(match.id, "Side", sider, match.mapIds[1], "CT");

    await postgres.query(
      "DELETE FROM match_map_veto_picks WHERE match_id = $1 AND map_id = $2",
      [match.id, match.mapIds[1]],
    );

    const maps = await postgres.query<Array<{ id: string }>>(
      "SELECT id FROM match_maps WHERE match_id = $1",
      [match.id],
    );
    expect(maps.length).toBe(0);
  });

  it("cancelling a match mid-veto wipes its veto picks", async () => {
    const match = await createVetoMatch(1, 3);
    await insertPick(match.id, "Ban", match.lineup_1_id, match.mapIds[0]);

    await postgres.query(
      "UPDATE matches SET status = 'Canceled' WHERE id = $1",
      [match.id],
    );

    const picks = await postgres.query<Array<{ id: string }>>(
      "SELECT id FROM match_map_veto_picks WHERE match_id = $1",
      [match.id],
    );
    expect(picks.length).toBe(0);
  });

  // Arbitrary pool sizes (fix for the >7-map deadlock): get_map_veto_pattern
  // used to hardcode a fixed 7-element BO3/BO5 array and pad any excess maps
  // as Bans appended AFTER the Decider, which get_map_veto_type would then
  // report as the next required step while real maps still remained --
  // permanently deadlocking the veto (nothing could satisfy that step: the
  // client has no Decider control, and create_match_map_from_veto only
  // auto-inserts a Decider once exactly one real map is left). The fix
  // computes the pattern directly at the correct length for every pool size:
  // ban_count = pool_size - best_of maps must be removed, up to 2 of them
  // open the veto (the normal CS opening) before the best_of-1 picks, and
  // any remainder lands after the picks but always before the Decider.
  describe("arbitrary map pool sizes (BO3/BO5 >7-map fix)", () => {
    // Mirrors the SQL formula in get_map_veto_pattern.sql exactly, so the
    // matrix below exercises the real algorithm as a black box across every
    // pool size instead of hand-writing each expected array.
    const expectedPattern = (bestOf: number, poolSize: number): string[] => {
      const base: string[] = [];
      if (bestOf === 1) {
        for (let i = 0; i < poolSize - 1; i++) base.push("Ban");
        base.push("Decider");
      } else {
        const banCount = poolSize - bestOf;
        const preBans = Math.min(banCount, 2);
        const postBans = banCount - preBans;
        for (let i = 0; i < preBans; i++) base.push("Ban");
        for (let i = 0; i < bestOf - 1; i++) base.push("Pick");
        for (let i = 0; i < postBans; i++) base.push("Ban");
        base.push("Decider");
      }
      const actual: string[] = [];
      for (const type of base) {
        if (type === "Pick") actual.push("Pick", "Side");
        else actual.push(type);
      }
      return actual;
    };

    it.each([
      [1, 1],
      [1, 3],
      [1, 7],
      [1, 15],
      [1, 20],
      [3, 3],
      [3, 5],
      [3, 7],
      [3, 8],
      [3, 15],
      [3, 20],
      [5, 5],
      [5, 6],
      [5, 7],
      [5, 8],
      [5, 15],
      [5, 20],
    ])(
      "BO%i pool %i: correct pattern, ban/pick/side/decider counts, Decider last with nothing after it",
      async (bestOf, poolSize) => {
        const match = await createVetoMatch(bestOf, poolSize);
        const [{ pattern }] = await postgres.query<
          Array<{ pattern: string[] }>
        >(
          "SELECT get_map_veto_pattern(m) AS pattern FROM matches m WHERE id = $1",
          [match.id],
        );

        expect(pattern).toEqual(expectedPattern(bestOf, poolSize));

        const banCount = pattern.filter((t) => t === "Ban").length;
        const pickCount = pattern.filter((t) => t === "Pick").length;
        const sideCount = pattern.filter((t) => t === "Side").length;
        const deciderCount = pattern.filter((t) => t === "Decider").length;

        expect(banCount).toBe(poolSize - bestOf);
        expect(pickCount).toBe(bestOf === 1 ? 0 : bestOf - 1);
        // Every Pick is immediately followed by a Side.
        expect(sideCount).toBe(pickCount);
        expect(deciderCount).toBe(1);
        // Decider is the pattern's final element -- nothing after it.
        expect(pattern[pattern.length - 1]).toBe("Decider");
        expect(pattern.indexOf("Decider")).toBe(pattern.length - 1);
      },
    );

    // Explicit, formula-independent regression locks (hand-written, not
    // derived from expectedPattern above) for the three cases called out by
    // name in the investigation.
    it("regression lock: BO3 pool 5 is Ban,Ban,Pick,Side,Pick,Side,Decider (was the wrong-order bug)", async () => {
      const match = await createVetoMatch(3, 5);
      const [{ pattern }] = await postgres.query<
        Array<{ pattern: string[] }>
      >(
        "SELECT get_map_veto_pattern(m) AS pattern FROM matches m WHERE id = $1",
        [match.id],
      );
      expect(pattern).toEqual([
        "Ban",
        "Ban",
        "Pick",
        "Side",
        "Pick",
        "Side",
        "Decider",
      ]);
    });

    it("regression lock: BO3 pool 7 is unchanged", async () => {
      const match = await createVetoMatch(3, 7);
      const [{ pattern }] = await postgres.query<
        Array<{ pattern: string[] }>
      >(
        "SELECT get_map_veto_pattern(m) AS pattern FROM matches m WHERE id = $1",
        [match.id],
      );
      expect(pattern).toEqual([
        "Ban",
        "Ban",
        "Pick",
        "Side",
        "Pick",
        "Side",
        "Ban",
        "Ban",
        "Decider",
      ]);
    });

    it("regression lock: BO5 pool 7 is unchanged", async () => {
      const match = await createVetoMatch(5, 7);
      const [{ pattern }] = await postgres.query<
        Array<{ pattern: string[] }>
      >(
        "SELECT get_map_veto_pattern(m) AS pattern FROM matches m WHERE id = $1",
        [match.id],
      );
      expect(pattern).toEqual([
        "Ban",
        "Ban",
        "Pick",
        "Side",
        "Pick",
        "Side",
        "Pick",
        "Side",
        "Pick",
        "Side",
        "Decider",
      ]);
    });

    it("BO1/pool1 still auto-assigns without entering veto (the one genuinely decisionless case)", async () => {
      const match = await createVetoMatch(1, 1);
      const state = await vetoState(match.id);
      expect(state.status).toBe("Live");

      const maps = await postgres.query<Array<{ map_id: string }>>(
        "SELECT map_id FROM match_maps WHERE match_id = $1",
        [match.id],
      );
      expect(maps.length).toBe(1);
      expect(maps[0].map_id).toBe(match.mapIds[0]);
    });

    it.each([
      [3, 3],
      [5, 5],
    ])(
      "BO%i/pool%i now enters veto instead of auto-skipping it (setup_match_maps fix)",
      async (bestOf, poolSize) => {
        const match = await createVetoMatch(bestOf, poolSize);
        const state = await vetoState(match.id);
        expect(state.status).toBe("Veto");
        // No bans required (ban_count = poolSize - bestOf = 0): the first
        // step is straight into the picks.
        expect(state.veto_type).toBe("Pick");

        const maps = await postgres.query<Array<{ id: string }>>(
          "SELECT id FROM match_maps WHERE match_id = $1",
          [match.id],
        );
        expect(maps.length).toBe(0);
      },
    );

    it("BO5: opponent of the picker chooses the Side for every one of the 4 picks", async () => {
      const match = await createVetoMatch(5, 7);

      // Two opening bans (pre_bans = min(2, 2) = 2).
      let state = await vetoState(match.id);
      await insertPick(match.id, "Ban", state.picking!, match.mapIds[0]);
      state = await vetoState(match.id);
      await insertPick(match.id, "Ban", state.picking!, match.mapIds[1]);

      for (let i = 0; i < 4; i++) {
        state = await vetoState(match.id);
        expect(state.veto_type).toBe("Pick");
        const picker = state.picking!;
        const mapId = match.mapIds[2 + i];
        await insertPick(match.id, "Pick", picker, mapId);

        state = await vetoState(match.id);
        expect(state.veto_type).toBe("Side");
        const opponent =
          picker === match.lineup_1_id ? match.lineup_2_id : match.lineup_1_id;
        expect(state.picking).toBe(opponent);
        await insertPick(match.id, "Side", opponent, mapId, "CT");
      }

      expect((await vetoState(match.id)).status).toBe("Live");
    });

    // Drives a full veto end-to-end by always submitting whatever the SQL
    // reports as the next required step/lineup, rather than only inspecting
    // the pattern array -- this is the direct proof that a large pool
    // completes without deadlocking, not just that the literal matches.
    const runFullVeto = async (match: {
      id: string;
      lineup_1_id: string;
      lineup_2_id: string;
      mapIds: string[];
    }) => {
      const usedMapIds = new Set<string>();
      let lastPickedMapId: string | null = null;

      for (let guard = 0; guard < 200; guard++) {
        const state = await vetoState(match.id);
        if (state.status !== "Veto") return state;

        // The bug this fix targets: get_map_veto_type must never report
        // Decider as the next step while more than one real map remains --
        // Decider is exclusively auto-inserted by create_match_map_from_veto,
        // never submitted here, so this would otherwise hang forever.
        expect(state.veto_type).not.toBe("Decider");

        if (state.veto_type === "Side") {
          await insertPick(
            match.id,
            "Side",
            state.picking!,
            lastPickedMapId!,
            "CT",
          );
        } else {
          const mapId = match.mapIds.find((id) => !usedMapIds.has(id))!;
          usedMapIds.add(mapId);
          if (state.veto_type === "Pick") lastPickedMapId = mapId;
          await insertPick(match.id, state.veto_type!, state.picking!, mapId);
        }
      }
      throw new Error(
        "Veto did not complete within guard limit -- likely deadlocked",
      );
    };

    it("drives a large BO3 pool (15 maps) through veto to completion without deadlocking", async () => {
      const match = await createVetoMatch(3, 15);
      const finalState = await runFullVeto(match);
      expect(finalState!.status).toBe("Live");

      const maps = await postgres.query<Array<{ map_id: string }>>(
        "SELECT map_id FROM match_maps WHERE match_id = $1",
        [match.id],
      );
      expect(maps.length).toBe(3);

      const picks = await postgres.query<Array<{ type: string }>>(
        "SELECT type FROM match_map_veto_picks WHERE match_id = $1",
        [match.id],
      );
      expect(picks.filter((p) => p.type === "Ban").length).toBe(12);
      expect(picks.filter((p) => p.type === "Pick").length).toBe(2);
      expect(picks.filter((p) => p.type === "Decider").length).toBe(1);
    });

    it("drives a large BO5 pool (15 maps) through veto to completion without deadlocking", async () => {
      const match = await createVetoMatch(5, 15);
      const finalState = await runFullVeto(match);
      expect(finalState!.status).toBe("Live");

      const maps = await postgres.query<Array<{ map_id: string }>>(
        "SELECT map_id FROM match_maps WHERE match_id = $1",
        [match.id],
      );
      expect(maps.length).toBe(5);

      const picks = await postgres.query<Array<{ type: string }>>(
        "SELECT type FROM match_map_veto_picks WHERE match_id = $1",
        [match.id],
      );
      expect(picks.filter((p) => p.type === "Ban").length).toBe(10);
      expect(picks.filter((p) => p.type === "Pick").length).toBe(4);
      expect(picks.filter((p) => p.type === "Decider").length).toBe(1);
    });
  });
});
