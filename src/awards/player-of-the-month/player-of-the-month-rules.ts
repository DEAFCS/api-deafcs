// Player of the Month candidate rules (pure; unit-tested in
// player-of-the-month-rules.spec.ts). The service feeds it rows read from the
// database; the result is stored as the month's review snapshot, so a past
// decision keeps showing the rules and evidence it was made with.
//
// The award goes to the player with the most legitimate completed matches in
// the calendar month (UTC). The calculation only ranks and explains; staff
// review the evidence and approve (or reject) before anything is awarded.
//
// Each policy is a named setting, so a change is one value (and a new
// `version`, stored with every snapshot) instead of new code.

export type MatchCategory = "matchmaking" | "tournament" | "draft" | "custom";

export const PLAYER_OF_THE_MONTH_RULES = {
  // v2 (TricoN, 2026-10-20): only bans and warnings issued by DEAFCS staff
  // disqualify; Steam VAC/game bans (and the automatic Steam VAC ban
  // sanction) are shown for information only. Matchmaking eligibility and
  // blacklist enforcement are separate and unchanged.
  // v3 (TricoN, 2026-10-21): equal match counts are decided by total rounds
  // played; only equal matches AND rounds remain a tie for staff. Draft
  // Room, custom and ELO-voided matches stay excluded. Staff approval stays
  // mandatory, with eligibility rechecked inside the approval.
  version: 3,
  timezone: "UTC",
  matchTypes: ["Competitive", "Wingman", "Duel"] as string[],
  // Draft-room and organizer-created custom matches are shown to staff but
  // not counted (easy to arrange between friends).
  countedCategories: ["matchmaking", "tournament"] as MatchCategory[],
  // Matches whose ELO staff/system voided are not counted.
  countEloVoided: false,
  // Staff bans: disqualify when active at any time during the month.
  // Staff warnings: disqualify when issued during the month (an old warning
  // without an end date would otherwise disqualify forever).
  repeatWindowMonths: 12,
  // How many eligible candidates the review lists (plus any ineligible
  // player ranked above the last of them, so nobody is dropped silently).
  eligibleCandidatesShown: 10,
  // Activity indicators shown to staff (never automatic exclusions).
  indicators: {
    shortMatchRounds: 10,
    busyDayMatches: 12,
    repeatedLineupMatches: 3,
  },
};

export type PlayerOfTheMonthRules = typeof PLAYER_OF_THE_MONTH_RULES;

export type MonthMatch = {
  id: string;
  type: string;
  category: MatchCategory;
  eloVoided: boolean;
  endedAt: string;
  // Recorded rounds of the match (warmup/knife are never recorded).
  rounds: number;
  lineup1: string[];
  lineup2: string[];
  // Players with recorded per-match stats (demo parsed).
  withStats: string[];
};

export type SanctionRow = {
  steamId: string;
  type: string;
  createdAt: string;
  removeSanctionDate: string | null;
  deletedAt: string | null;
  reason: string | null;
  system: boolean;
};

export type PlayerRow = {
  steamId: string;
  name: string;
  avatarUrl: string | null;
  country: string | null;
  vacBanned: boolean;
  vacBanCount: number;
  gameBanCount: number;
};

export type PreviousWin = { steamId: string; month: string };

export type CandidateEvidence = {
  steamId: string;
  name: string;
  avatarUrl: string | null;
  country: string | null;
  rank: number;
  eligibleMatches: number;
  roundsPlayed: number;
  byType: Record<string, number>;
  tournamentMatches: number;
  notCounted: { draft: number; custom: number; eloVoided: number };
  sanctions: Array<SanctionRow & { effect: "disqualifying" | "review" | "info" }>;
  previousWins: string[];
  vac: { banned: boolean; vacBanCount: number; gameBanCount: number };
  indicators: {
    shortMatches: number;
    busiestDay: { date: string; matches: number } | null;
    repeatedLineupMatches: number;
    matchesWithoutStats: number;
  };
  flags: string[];
  disqualifiedBy: string[];
  eligible: boolean;
  tiedWithNext: boolean;
};

export type CandidateSnapshot = {
  month: string;
  rulesVersion: number;
  totalMatchesConsidered: number;
  recommendedSteamId: string | null;
  candidates: CandidateEvidence[];
};

export function monthRange(month: string): { start: Date; end: Date; key: string } {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) throw new Error("Month must be YYYY-MM");
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  if (monthIndex < 0 || monthIndex > 11 || year < 2020) throw new Error("Month must be YYYY-MM");
  return {
    start: new Date(Date.UTC(year, monthIndex, 1)),
    end: new Date(Date.UTC(year, monthIndex + 1, 1)),
    key: `${match[1]}-${match[2]}`,
  };
}

export function categoryOf(m: { isTournament: boolean; isDraft: boolean; hasOrganizer: boolean }): MatchCategory {
  if (m.isTournament) return "tournament";
  if (m.isDraft) return "draft";
  if (m.hasOrganizer) return "custom";
  return "matchmaking";
}

type Totals = {
  steamId: string;
  counted: Set<string>;
  rounds: number;
  byType: Record<string, number>;
  tournament: number;
  notCounted: { draft: number; custom: number; eloVoided: number };
  perDay: Map<string, number>;
  short: number;
  withoutStats: number;
  lineupKeys: string[];
};

function tally(month: string, matches: MonthMatch[], rules: PlayerOfTheMonthRules): Totals[] {
  const { start, end } = monthRange(month);
  const totals = new Map<string, Totals>();
  const get = (steamId: string) => {
    let t = totals.get(steamId);
    if (!t) {
      t = {
        steamId,
        counted: new Set(),
        rounds: 0,
        byType: {},
        tournament: 0,
        notCounted: { draft: 0, custom: 0, eloVoided: 0 },
        perDay: new Map(),
        short: 0,
        withoutStats: 0,
        lineupKeys: [],
      };
      totals.set(steamId, t);
    }
    return t;
  };

  for (const match of matches) {
    if (!rules.matchTypes.includes(match.type)) continue;
    const ended = new Date(match.endedAt);
    if (!(ended >= start && ended < end)) continue;
    // A player listed twice (or in both lineups) still counts the match once.
    const seated = new Set([...match.lineup1, ...match.lineup2]);
    const stats = new Set(match.withStats);
    for (const steamId of seated) {
      const t = get(steamId);
      if (match.eloVoided && !rules.countEloVoided) {
        t.notCounted.eloVoided++;
        continue;
      }
      if (!rules.countedCategories.includes(match.category)) {
        if (match.category === "draft") t.notCounted.draft++;
        else if (match.category === "custom") t.notCounted.custom++;
        continue;
      }
      if (t.counted.has(match.id)) continue;
      t.counted.add(match.id);
      t.rounds += match.rounds;
      t.byType[match.type] = (t.byType[match.type] ?? 0) + 1;
      if (match.category === "tournament") t.tournament++;
      const day = ended.toISOString().slice(0, 10);
      t.perDay.set(day, (t.perDay.get(day) ?? 0) + 1);
      if (match.rounds < rules.indicators.shortMatchRounds) t.short++;
      if (!stats.has(steamId)) t.withoutStats++;
      // Same ten (or four, or two) players together again and again.
      t.lineupKeys.push([...seated].sort().join(","));
    }
  }

  return [...totals.values()]
    .filter((t) => t.counted.size > 0)
    .sort(
      (a, b) =>
        b.counted.size - a.counted.size ||
        b.rounds - a.rounds ||
        a.steamId.localeCompare(b.steamId),
    );
}

// The players worth looking up (sanctions, bans, previous wins): the top of
// the ranking by counted matches.
export function playersToCheck(
  month: string,
  matches: MonthMatch[],
  limit: number,
  rules: PlayerOfTheMonthRules = PLAYER_OF_THE_MONTH_RULES,
): string[] {
  return tally(month, matches, rules).slice(0, limit).map((t) => t.steamId);
}

// Rank players by eligible matches. `details` must cover at least the
// players playersToCheck() returned.
export function rankPlayerOfTheMonth(
  month: string,
  matches: MonthMatch[],
  details: {
    players: PlayerRow[];
    sanctions: SanctionRow[];
    previousWins: PreviousWin[];
  },
  rules: PlayerOfTheMonthRules = PLAYER_OF_THE_MONTH_RULES,
): CandidateSnapshot {
  const { start, end, key } = monthRange(month);
  const ranked = tally(month, matches, rules);

  const players = new Map(details.players.map((p) => [p.steamId, p]));
  const repeatStart = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - rules.repeatWindowMonths, 1));

  const candidates: CandidateEvidence[] = [];
  let eligibleCount = 0;
  for (const t of ranked) {
    if (eligibleCount >= rules.eligibleCandidatesShown) break;
    const player = players.get(t.steamId);
    const disqualifiedBy: string[] = [];
    const flags: string[] = [];

    const sanctions = details.sanctions
      .filter((s) => s.steamId === t.steamId)
      .map((s) => {
        const created = new Date(s.createdAt);
        const until = s.removeSanctionDate ? new Date(s.removeSanctionDate) : null;
        const overlapsMonth = created < end && (!until || until > start);
        const issuedInMonth = created >= start && created < end;
        let effect: "disqualifying" | "review" | "info" = "info";
        // Only DEAFCS's own (staff-issued) bans and warnings count. A sanction
        // without a staff member is the automatic Steam VAC ban (the only
        // writer of system sanctions, steam-bans.service.ts): information only.
        if (s.system) {
          effect = "info";
        } else if (s.deletedAt && overlapsMonth && (s.type === "ban" || s.type === "warning")) {
          // Removed/revoked later: not applied automatically, staff decide.
          effect = "review";
        } else if (!s.deletedAt && s.type === "ban" && overlapsMonth) {
          effect = "disqualifying";
        } else if (!s.deletedAt && s.type === "warning" && issuedInMonth) {
          effect = "disqualifying";
        }
        return { ...s, effect };
      })
      .filter((s) => {
        const created = new Date(s.createdAt);
        const until = s.removeSanctionDate ? new Date(s.removeSanctionDate) : null;
        return created < end && (!until || until > start);
      });
    for (const s of sanctions) {
      if (s.effect === "disqualifying") disqualifiedBy.push(`${s.type} ${s.createdAt.slice(0, 10)}`);
      if (s.effect === "review") flags.push(`removed ${s.type} from ${s.createdAt.slice(0, 10)}: check`);
    }

    const vac = {
      banned: !!player?.vacBanned,
      vacBanCount: player?.vacBanCount ?? 0,
      gameBanCount: player?.gameBanCount ?? 0,
    };
    // Steam VAC/game bans (other games) never decide the award; the numbers
    // stay in the evidence (vac) for staff to see.

    const previousWins = details.previousWins
      .filter((w) => w.steamId === t.steamId)
      .map((w) => w.month)
      .filter((m) => {
        const d = new Date(`${m}-01T00:00:00Z`);
        return d >= repeatStart && d < start;
      })
      .sort();
    if (previousWins.length) disqualifiedBy.push(`won ${previousWins[previousWins.length - 1]} (12-month rule)`);

    const busiest = [...t.perDay.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    const lineupCounts = new Map<string, number>();
    for (const k of t.lineupKeys) lineupCounts.set(k, (lineupCounts.get(k) ?? 0) + 1);
    const repeated = [...lineupCounts.values()]
      .filter((n) => n >= rules.indicators.repeatedLineupMatches)
      .reduce((sum, n) => sum + n, 0);
    const indicators = {
      shortMatches: t.short,
      busiestDay: busiest ? { date: busiest[0], matches: busiest[1] } : null,
      repeatedLineupMatches: repeated,
      matchesWithoutStats: t.withoutStats,
    };
    if (indicators.shortMatches) flags.push(`${indicators.shortMatches} short match(es) under ${rules.indicators.shortMatchRounds} rounds`);
    if (busiest && busiest[1] >= rules.indicators.busyDayMatches) flags.push(`${busiest[1]} matches on ${busiest[0]}`);
    if (repeated) flags.push(`${repeated} match(es) with the exact same players ${rules.indicators.repeatedLineupMatches}+ times`);
    if (indicators.matchesWithoutStats) flags.push(`${indicators.matchesWithoutStats} match(es) without recorded stats`);
    if (!player) flags.push("player record not found");

    const eligible = disqualifiedBy.length === 0;
    if (eligible) eligibleCount++;
    candidates.push({
      steamId: t.steamId,
      name: player?.name ?? t.steamId,
      avatarUrl: player?.avatarUrl ?? null,
      country: player?.country ?? null,
      rank: candidates.length + 1,
      eligibleMatches: t.counted.size,
      roundsPlayed: t.rounds,
      byType: t.byType,
      tournamentMatches: t.tournament,
      notCounted: t.notCounted,
      sanctions,
      previousWins,
      vac,
      indicators,
      flags,
      disqualifiedBy,
      eligible,
      tiedWithNext: false,
    });
  }

  // The ranking (tally) is matches, then total rounds played. Only equal
  // matches AND equal rounds are left as a tie for staff to settle.
  const eligibleList = candidates.filter((c) => c.eligible);
  for (let i = 0; i < eligibleList.length - 1; i++) {
    const [a, b] = [eligibleList[i], eligibleList[i + 1]];
    if (a.eligibleMatches === b.eligibleMatches && a.roundsPlayed === b.roundsPlayed) {
      a.tiedWithNext = true;
    }
  }

  return {
    month: key,
    rulesVersion: rules.version,
    totalMatchesConsidered: matches.length,
    recommendedSteamId: eligibleList[0]?.steamId ?? null,
    candidates,
  };
}

// One player's evidence under the same rules, wherever they rank (the review
// list is cut after `eligibleCandidatesShown`). Used by the approval to
// recheck the chosen winner on current data. `details` must cover this
// player; null when they have no counted match in the month.
export function evaluateCandidate(
  month: string,
  matches: MonthMatch[],
  details: { players: PlayerRow[]; sanctions: SanctionRow[]; previousWins: PreviousWin[] },
  steamId: string,
  rules: PlayerOfTheMonthRules = PLAYER_OF_THE_MONTH_RULES,
): CandidateEvidence | null {
  const all = rankPlayerOfTheMonth(month, matches, details, {
    ...rules,
    eligibleCandidatesShown: Number.MAX_SAFE_INTEGER,
  });
  return all.candidates.find((c) => c.steamId === steamId) ?? null;
}
