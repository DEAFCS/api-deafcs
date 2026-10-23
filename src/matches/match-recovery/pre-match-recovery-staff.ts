import { PostgresService } from "src/postgres/postgres.service";

// DEAFCS: who may run a pre-match recovery (Reset Veto, Reset Captain Pick),
// also while playing in the match: administrators and match organizers on
// every match, tournament organizers on their own tournaments' matches. A
// match's owner, someone listed as a tournament's organizer without the role,
// and moderators may not. Callers also check matches.is_organizer first.
export async function isPreMatchRecoveryStaff(
  postgres: Pick<PostgresService, "query">,
  matchId: string,
  viewer: { steam_id: string; role: string },
): Promise<boolean> {
  if (viewer.role === "administrator" || viewer.role === "match_organizer") {
    return true;
  }

  if (viewer.role !== "tournament_organizer") {
    return false;
  }

  const [row] = await postgres.query<Array<{ own: boolean }>>(
    `SELECT EXISTS (
              SELECT 1
                FROM tournament_brackets tb
                JOIN tournament_stages ts ON ts.id = tb.tournament_stage_id
                JOIN tournaments t ON t.id = ts.tournament_id
               WHERE tb.match_id = $1
                 AND (
                   t.organizer_steam_id = $2
                   OR EXISTS (
                     SELECT 1 FROM tournament_organizers o
                      WHERE o.tournament_id = t.id AND o.steam_id = $2
                   )
                 )
            ) AS own`,
    [matchId, viewer.steam_id],
  );

  return !!row?.own;
}
