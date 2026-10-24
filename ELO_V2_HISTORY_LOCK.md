# DEAFCS ELO v2 and the ELO history lock

Status: implemented and tested locally. **Not activated.** Deploying this code
changes no rating: until an authorized activation inserts the first lock, every
match is rated exactly as before.

## What ELO v2 is

Every ELO-rated 5v5 match (matchmaking Captain Pick and Random, tournaments,
leagues, any future 5v5 source). Eligibility is the match format
(`get_match_type_min_players(type) = 5`), not its source. Duel (1v1) and
Wingman (2v2) are unchanged: 4,000 scale, the original Impact and PERF.

| | ELO v2 (5v5) | Version 1 (Duel, Wingman, all 5v5 before activation) |
|---|---|---|
| Scale | 10,000 | 4,000 |
| K | 500 | 500 |
| Start rating | 5,000 | 5,000 |
| Impact | existing DEAFCS HLTV-style match rating (`v_player_match_rating`) | KDA vs team + damage share, 0.80-1.20 |
| PERF on a win | clamp(1 + 0.5 x (rating - 1.00), 0.75, 1.25) | Impact |
| PERF on a loss | 2 - win PERF | 0.9 - 2.125 x (Impact - 0.8), 0.05-1.00 |
| Missing rating | PERF 1.00, Impact stored as NULL | Impact 1.0 |

`change = round(K x (actual - expected) x PERF x series)` with
`expected = 1 / (1 + 10^((opponent average - own rating) / scale))`.
Rounding is PostgreSQL `round()` on a float (ties to even), as before. Series
factor, leaver penalty (flat -250), no-show penalty, void, scrims, draft opt-out,
substitutes and tournament/league rules are unchanged.

Code: `hasura/functions/elo/elo_v2_formula.sql` (the two formula pieces),
`hasura/functions/match/match_player_elo.sql` (`get_player_elo_for_match`,
`generate_player_elo_for_match`).

## Which formula a match uses

`matches.elo_version` is stamped once, when the match starts (or ends without
starting), from the lock in effect at that moment, and can't be changed
afterwards (`tbu_matches_elo_history`). So:

- a match already underway at activation keeps version 1, even if it ends later;
- a match created before activation but started after it gets v2;
- matches from before this code have no stamp and are derived from their own
  start time, which is before any lock, so version 1.

Every `player_elo` row records the formula (`elo_version`) and scale
(`scale_factor`) that produced it, and the popup shows those stored values.

## The history lock

Table `elo_history_locks` (migration `1891300000100_elo_history_lock`),
append-only. The latest `locked_before` is the boundary. Enforced in the
database (`hasura/triggers/elo_history_lock.sql`), so no job or admin action can
bypass it:

- `player_elo` rows created before the boundary can't be inserted, updated or
  deleted; `TRUNCATE player_elo` is refused while any lock exists;
- a match in the locked history can't have its ELO voided or restored, and a
  rated locked match can't be deleted (canceled matches still delete);
- deleting a player account still removes that player's own rows;
- `generate_player_elo_for_match` leaves a locked match exactly as it is.

API guards on top, with clear messages: Void ELO refuses a locked match; the
admin "Recompute ELO" rebuilds only after the boundary; the season backfill
refuses a season that starts before the boundary; the startup backfill skips.

## Void Match and Recalculate ELO after activation

`recompute_elo_after_lock()` runs in one transaction under the same advisory
lock as every live calculation (so a match finishing meanwhile waits):

1. delete the rated rows after the boundary (never locked rows);
2. replay every rated match that ended after the boundary in end-time order;
   each starts from the players' ratings as they stand: their last locked
   rating, then the rebuilt rows. Never from 5,000, never replaying locked
   matches;
3. keep no-show penalty rows (canceled matches can't be recalculated) and
   re-base them on the rebuilt rating before them.

Deterministic and idempotent: the same data gives the same rows. Example
(tested): locked baseline 8,500, A +300, B +200; void A, then A is 0, B starts
from 8,500 and is recalculated with v2 from that balance.

The admin Recompute button and Void ELO use it automatically once a lock exists.

## Activation (needs separate GO)

After deploying (Hasura init with the new API image, then API, then WEB):

```sql
SELECT activate_elo_v2('ELO v2 activation, approved by Anders', <admin steam id>);
```

It refuses if v2 is already active, or if a rated match ended in the last day
without ELO (its calculation is still queued; wait and retry). Activation
changes no rating; it only adds the lock row.

Rollback of the code after activation: roll back WEB, API and the Hasura init
image; the lock table and guards stay (the migration's `down.sql` refuses to
drop a lock). Ratings are never touched by a rollback.

## Season 2 (1 January 2027): needs a decision

Production already has **Season 2 from 2027-01-01 00:00 UTC to 2027-07-01**
(created 2026-08-18) and `public.seasons_enabled = true`. Each season has its
own ELO stream, so at that moment **every mode (5v5, Wingman, Duel) restarts at
5,000 automatically**, with no action. Season 1 rows, leaderboards (season
selector) and awards stay. If the reset must wait for a separate approval,
Season 2's start has to be moved before 1 January (an admin season edit,
production data, needs GO).

To do at the transition (with GO):

1. Confirm the Season 2 row and whether Wingman/Duel should reset too (they
   will, with the current season system).
2. Shortly after the start, once Season 1's last matches have their ELO:
   `SELECT lock_elo_history('Season 1 closed', 2::smallint, <steam id>, '2027-01-01 00:00:00+00');`
   That makes all of Season 1 permanent (until then, Season 1 matches after the
   v2 activation stay recomputable).
3. Matches that start in Season 1 and end after midnight belong to Season 2
   (season = end time), as today.
4. Check the Season 2 leaderboards and that new matches start from 5,000.

## Simulation (read-only, production data, 2026-10-24)

587 rated 5v5 matches (2026-09-15 to 2026-10-24), 5,870 rows, 207 players, 260
tournament rows, 28 leaver penalties, 10 voided. The replay harness reproduces
the stored version 1 history exactly (0 of 5,870 rows differ).

| | Stored (version 1) | Replayed with v2 |
|---|---|---|
| Average win / loss | +246 / -115 | +276 / -246 |
| Net rating created | +380,470 | +84,932 |
| Mean rating | 6,838 | 5,410 |
| p10 / median / p90 | 4,911 / 6,251 / 9,561 | 4,203 / 5,255 / 6,844 |
| Lowest / highest | 4,422 / 10,963 | 774 / 9,548 |
| Correlation HLTV vs change (wins / losses) | -0.28 / 0.16 | 0.21 / 0.50 |

- Version 1 rewards performance backwards on wins and shrinks losses heavily,
  so ratings inflate fast. v2 rewards strong games (HLTV >= 1.30: +285 win,
  -214 loss; <= 0.70: +228 win, -273 loss) and is close to symmetric.
- Risk: the DEAFCS HLTV-style rating averages 1.16 (median 1.15, winners 1.34,
  losers 0.98), above the agreed neutral 1.00, so v2 still creates some rating
  (about +14 per rated row). A neutral at the population median would remove it;
  not changed, as agreed.
- v2 spreads ratings in both directions (one player would drop to 774); version
  1 mostly moves everyone up.
