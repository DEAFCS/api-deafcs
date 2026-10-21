// 1:1 port of the WEB homepage calculation (deafcs-web
// components/home/dashboard/weeklyRecords.ts). Keep the two identical: the
// WEB falls back to computing in the browser when this API route is not
// available, and both must give the same records. Parity is checked by
// weekly-records.spec.ts (same cases as the WEB test) and a real-data
// comparison before release.
//
// "Last 7 days" community records for the signed-in homepage. Pure, so the
// rules are unit-tested (test/home-dashboard.test.mjs).
//
// Inputs are rows for finished DEAFCS Competitive (5v5) matches of the last
// 7 days (status Finished excludes forfeits and surrenders):
// - v_player_match_rating: per player per match rounds, ADR, rating
// - player_match_stats_v: per player per match kills, headshot kills, deaths
// - v_match_clutches (won only) and v_match_player_opening_duels: both read
//   match_map_rounds with round > 0, and DEAFCS records only the scored
//   rounds (1..N, no warmup or knife round), so neither counts those.
// Records are for fun only; nothing here is awarded.

// Rate-based records (rating, ADR, headshot %, DPR) only count players with
// enough play behind the number, so one lucky short match cannot top them.
export const RATE_MIN_MATCHES = 3;
export const RATE_MIN_ROUNDS = 50;
// Headshot % also needs a fair number of kills.
export const HS_MIN_KILLS = 30;
// Single-match records need this many rounds played in that match.
export const SINGLE_MATCH_MIN_ROUNDS = 10;
export const RECORD_PLACES = 5;

export type RatingRow = {
  steam_id: string;
  match_id: string;
  adr: number | string | null;
  hltv_rating: number | string | null;
  rounds_played: number | null;
};

export type StatsRow = {
  steam_id: string;
  match_id: string;
  kills: number | null;
  hs_kills: number | null;
  deaths?: number | null;
};

// One row per won clutch (v_match_clutches, outcome = won).
export type ClutchRow = { match_id: string; clutcher_steam_id: string };
// v_match_player_opening_duels: one row per player, map and side.
export type OpeningRow = { match_id: string; steam_id: string; wins: number | null };

export type RecordKey =
  | "rating"
  | "adr"
  | "kills"
  | "hs"
  | "matches"
  | "match_kills"
  | "match_rating"
  | "match_adr"
  | "clutches"
  | "opening_kills"
  | "dpr";

export type RecordEntry = {
  steamId: string;
  // Competition ranking: equal values share a place (1, 1, 3).
  place: number;
  value: number;
  display: string;
  detail: string;
  matchId?: string;
};

export type WeeklyRecord = {
  key: RecordKey;
  title: string;
  unit: string;
  // Footer line under the card; every record has one so the card keeps
  // the same height whichever record is showing.
  rule: string;
  entries: RecordEntry[];
};

export const RECORD_ORDER: RecordKey[] = [
  "rating",
  "adr",
  "kills",
  "hs",
  "matches",
  "match_kills",
  "match_rating",
  "match_adr",
  "clutches",
  "opening_kills",
  "dpr",
];

type PlayerTotals = {
  steamId: string;
  matches: Set<string>;
  rounds: number;
  ratingRounds: number;
  adrRounds: number;
  kills: number;
  hsKills: number;
  deaths: number;
  clutches: number;
  openingKills: number;
};

const num = (value: unknown) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const plural = (count: number, word: "match" | "round" | "kill") =>
  `${count} ${count === 1 ? word : word === "match" ? "matches" : `${word}s`}`;

type Ranked = { steamId: string; value: number; tiebreak: number; display: string; detail: string; matchId?: string };

// Best first, then the deterministic tie-breaks; places use competition
// ranking on the value alone.
function placeEntries(rows: Ranked[], lowerIsBetter = false): RecordEntry[] {
  const sorted = rows
    .filter((r) => Number.isFinite(r.value))
    .sort(
      (a, b) =>
        (lowerIsBetter ? a.value - b.value : b.value - a.value) ||
        b.tiebreak - a.tiebreak ||
        a.steamId.localeCompare(b.steamId) ||
        (a.matchId ?? "").localeCompare(b.matchId ?? ""),
    )
    .slice(0, RECORD_PLACES);
  return sorted.map((row, index) => {
    const first = sorted.findIndex((other) => other.value === row.value);
    const { tiebreak: _tiebreak, ...entry } = row;
    return { ...entry, place: (first === -1 ? index : first) + 1 };
  });
}

function rank(
  players: PlayerTotals[],
  value: (p: PlayerTotals) => number,
  display: (v: number) => string,
  detail: (p: PlayerTotals) => string,
  lowerIsBetter = false,
): RecordEntry[] {
  return placeEntries(
    players
      .map((p) => ({ p, v: value(p) }))
      .filter(({ v }) => Number.isFinite(v) && (lowerIsBetter ? v >= 0 : v > 0))
      .map(({ p, v }) => ({
        steamId: p.steamId,
        value: v,
        tiebreak: p.matches.size,
        display: display(v),
        detail: detail(p),
      })),
    lowerIsBetter,
  );
}

export function weeklyRecords(
  ratings: RatingRow[],
  stats: StatsRow[],
  matchMr: Record<string, number | null | undefined>,
  extra: { clutches?: ClutchRow[] | null; openings?: OpeningRow[] | null } = {},
): WeeklyRecord[] {
  const players = new Map<string, PlayerTotals>();
  const player = (steamId: string) => {
    let p = players.get(steamId);
    if (!p) {
      p = {
        steamId,
        matches: new Set(),
        rounds: 0,
        ratingRounds: 0,
        adrRounds: 0,
        kills: 0,
        hsKills: 0,
        deaths: 0,
        clutches: 0,
        openingKills: 0,
      };
      players.set(steamId, p);
    }
    return p;
  };

  // Rounds of each match (its longest-playing player), to tell regulation
  // from overtime for the single-match kills record.
  const matchRounds = new Map<string, number>();
  // A player's own rounds in each match, for the single-match minimum.
  const playerRounds = new Map<string, number>();
  const singleRating: Ranked[] = [];
  const singleAdr: Ranked[] = [];

  for (const row of ratings) {
    const steamId = String(row.steam_id);
    const rounds = num(row.rounds_played);
    if (!rounds) continue;
    const p = player(steamId);
    p.matches.add(row.match_id);
    p.rounds += rounds;
    p.ratingRounds += num(row.hltv_rating) * rounds;
    p.adrRounds += num(row.adr) * rounds;
    matchRounds.set(row.match_id, Math.max(matchRounds.get(row.match_id) ?? 0, rounds));
    playerRounds.set(`${steamId}:${row.match_id}`, rounds);

    if (rounds >= SINGLE_MATCH_MIN_ROUNDS) {
      const detail = `in ${plural(rounds, "round")}`;
      if (row.hltv_rating !== null && row.hltv_rating !== undefined) {
        const v = num(row.hltv_rating);
        singleRating.push({ steamId, value: v, tiebreak: rounds, display: v.toFixed(2), detail, matchId: row.match_id });
      }
      if (row.adr !== null && row.adr !== undefined) {
        const v = num(row.adr);
        singleAdr.push({ steamId, value: v, tiebreak: rounds, display: v.toFixed(1), detail, matchId: row.match_id });
      }
    }
  }

  const singleKills: Ranked[] = [];
  for (const row of stats) {
    const steamId = String(row.steam_id);
    const kills = num(row.kills);
    const p = player(steamId);
    p.matches.add(row.match_id);
    p.kills += kills;
    p.hsKills += num(row.hs_kills);
    p.deaths += num(row.deaths);

    const mr = num(matchMr[row.match_id]) || 12;
    const rounds = matchRounds.get(row.match_id) ?? 0;
    const own = playerRounds.get(`${steamId}:${row.match_id}`) ?? 0;
    if (kills > 0 && own >= SINGLE_MATCH_MIN_ROUNDS && rounds <= mr * 2) {
      singleKills.push({
        steamId,
        value: kills,
        tiebreak: -own,
        display: String(kills),
        detail: `in ${plural(own, "round")}`,
        matchId: row.match_id,
      });
    }
  }

  for (const row of extra.clutches ?? []) {
    const p = players.get(String(row.clutcher_steam_id));
    if (p) p.clutches += 1;
  }
  for (const row of extra.openings ?? []) {
    const p = players.get(String(row.steam_id));
    if (p) p.openingKills += num(row.wins);
  }

  const all = [...players.values()];
  const rated = all.filter((p) => p.matches.size >= RATE_MIN_MATCHES && p.rounds >= RATE_MIN_ROUNDS);
  const matchesDetail = (p: PlayerTotals) => plural(p.matches.size, "match");
  const rateRule = `Min. ${RATE_MIN_MATCHES} matches and ${RATE_MIN_ROUNDS} rounds`;
  const singleRule = `Min. ${SINGLE_MATCH_MIN_ROUNDS} rounds played in the match`;
  const roundsOnly = "Warmup and knife rounds are not counted";

  const records: WeeklyRecord[] = [
    {
      key: "rating",
      title: "Top rating",
      unit: "Rating",
      rule: `${rateRule}. Weekly average`,
      entries: rank(rated, (p) => p.ratingRounds / p.rounds, (v) => v.toFixed(2), matchesDetail),
    },
    {
      key: "adr",
      title: "Highest ADR",
      unit: "ADR",
      rule: `${rateRule}. Weekly average`,
      entries: rank(rated, (p) => p.adrRounds / p.rounds, (v) => v.toFixed(1), matchesDetail),
    },
    {
      key: "kills",
      title: "Most kills",
      unit: "Kills",
      rule: "Total kills across the week",
      entries: rank(all, (p) => p.kills, (v) => String(v), matchesDetail),
    },
    {
      key: "hs",
      title: "Best headshot %",
      unit: "HS%",
      rule: `${rateRule}, ${HS_MIN_KILLS} kills`,
      entries: rank(
        rated.filter((p) => p.kills >= HS_MIN_KILLS),
        (p) => (p.hsKills / p.kills) * 100,
        (v) => `${Math.round(v)}%`,
        (p) => plural(p.kills, "kill"),
      ),
    },
    {
      key: "matches",
      title: "Most matches",
      unit: "Matches",
      rule: "Finished matches across the week",
      entries: rank(all, (p) => p.matches.size, (v) => String(v), (p) => plural(p.rounds, "round")),
    },
    {
      key: "match_kills",
      title: "Most kills in one match",
      unit: "Kills",
      rule: `${singleRule}. Regulation time only, no overtime`,
      entries: placeEntries(singleKills),
    },
    {
      key: "match_rating",
      title: "Best rating in one match",
      unit: "Rating",
      rule: singleRule,
      entries: placeEntries(singleRating),
    },
    {
      key: "match_adr",
      title: "Best ADR in one match",
      unit: "ADR",
      rule: singleRule,
      entries: placeEntries(singleAdr),
    },
  ];

  if (extra.clutches) {
    records.push({
      key: "clutches",
      title: "Most clutches won",
      unit: "Clutches",
      rule: `1vX rounds won. ${roundsOnly}`,
      entries: rank(all, (p) => p.clutches, (v) => String(v), matchesDetail),
    });
  }
  if (extra.openings) {
    records.push({
      key: "opening_kills",
      title: "Most opening kills",
      unit: "Opening kills",
      rule: `First kill of the round. ${roundsOnly}`,
      entries: rank(all, (p) => p.openingKills, (v) => String(v), matchesDetail),
    });
  }

  records.push({
    key: "dpr",
    title: "Lowest DPR",
    unit: "DPR",
    rule: `${rateRule}. Deaths divided by rounds played`,
    // Deaths come from the stats rows; without them there is no DPR.
    entries: rank(
      stats.length ? rated : [],
      (p) => p.deaths / p.rounds,
      (v) => v.toFixed(2),
      (p) => `${p.deaths} deaths, ${plural(p.rounds, "round")}`,
      true,
    ),
  });

  return records.filter((record) => record.entries.length > 0);
}
