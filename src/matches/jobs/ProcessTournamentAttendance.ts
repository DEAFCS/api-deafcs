import { Logger } from "@nestjs/common";
import { WorkerHost } from "@nestjs/bullmq";
import { MatchQueues } from "../enums/MatchQueues";
import { UseQueue } from "../../utilities/QueueProcessors";
import { PostgresService } from "../../postgres/postgres.service";
import { TournamentTeamGenerationService } from "../../tournaments/tournament-team-generation.service";

type DueTournament = {
  id: string;
  individual_registration_enabled: boolean;
  min_players_per_lineup: number | null;
  max_players_per_lineup: number | null;
};

// Automatic scheduling for the shared "tournament attendance" check-in
// window (both Solo Random and normal team tournaments), driven entirely
// by tournaments.start plus the two configurable offsets
// (attendance_check_in_open_before_minutes /
// attendance_check_in_close_before_minutes). Two independent, idempotent
// passes each tick -- mirrors CheckLeagueSeasonTransitions' style (plain
// conditional UPDATE ... WHERE status = X ... RETURNING id), not a new
// scheduling framework.
//
// Deliberately does not touch bracket/seeding/pairing internals: for team
// tournaments it only deletes no-show tournament_teams rows (the same
// action a captain/organizer already has) before flipping status to
// RegistrationClosed, letting the existing tau_tournaments trigger rebuild
// and seed the bracket exactly as it already does for any registration
// close. For Solo Random it delegates to TournamentTeamGenerationService,
// the same generator the manual "Generate Teams" organizer action uses.
//
// Uses a single common window, unlike ProcessTournamentCheckInExpiry's
// manual-flow reopen/promote loop -- this job resolves attendance exactly
// once per tournament and never reopens the window itself.
@UseQueue("Matches", MatchQueues.ScheduledMatches)
export class ProcessTournamentAttendance extends WorkerHost {
  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    private readonly teamGeneration: TournamentTeamGenerationService,
  ) {
    super();
  }

  async process(): Promise<{ opened: number; finalized: number }> {
    const opened = await this.openDueCheckIns();
    const finalized = await this.closeDueCheckIns();
    return { opened, finalized };
  }

  // start - open_before <= now(): open the shared attendance window, ending
  // at start - close_before. Guarded by individual_check_in_ends_at IS NULL
  // so this only ever fires once per tournament (idempotent against
  // repeated ticks) and never overwrites a window a manual action already
  // opened.
  private async openDueCheckIns(): Promise<number> {
    const rows = await this.postgres.query<Array<{ id: string }>>(
      `UPDATE public.tournaments
       SET individual_check_in_ends_at =
             start - (attendance_check_in_close_before_minutes::text || ' minutes')::interval,
           individual_check_in_duration_minutes =
             attendance_check_in_open_before_minutes - attendance_check_in_close_before_minutes
       WHERE status = 'RegistrationOpen'
         AND start IS NOT NULL
         AND individual_check_in_ends_at IS NULL
         AND start - (attendance_check_in_open_before_minutes::text || ' minutes')::interval <= now()
       RETURNING id`,
    );

    if (rows.length > 0) {
      this.logger.log(
        `opened tournament attendance check-in for ${rows.length} tournament(s)`,
      );
    }
    return rows.length;
  }

  // individual_check_in_ends_at <= now(): the shared window (opened above,
  // or by the manual "Start tournament check-in" action) has reached its
  // close_before cutoff.
  private async closeDueCheckIns(): Promise<number> {
    const due = await this.postgres.query<DueTournament[]>(
      `SELECT t.id,
              COALESCE(mo.individual_registration_enabled, false) AS individual_registration_enabled,
              tournament_min_players_per_lineup(t) AS min_players_per_lineup,
              tournament_max_players_per_lineup(t) AS max_players_per_lineup
       FROM public.tournaments t
       LEFT JOIN public.match_options mo ON mo.id = t.match_options_id
       WHERE t.status = 'RegistrationOpen'
         AND t.individual_check_in_ends_at IS NOT NULL
         AND t.individual_check_in_ends_at <= now()`,
    );

    for (const tournament of due) {
      try {
        await this.finalizeAttendance(tournament);
      } catch (error) {
        this.logger.error(
          `[${tournament.id}] failed to finalize tournament attendance`,
          error,
        );
      }
    }

    return due.length;
  }

  private async finalizeAttendance(tournament: DueTournament): Promise<void> {
    const tournamentId = tournament.id;
    let closedRegistration = false;

    await this.postgres.transaction(async (client) => {
      if (!tournament.individual_registration_enabled) {
        // Normal team tournament: remove no-show teams (registered before
        // check-in opened, never checked in) -- the same delete already
        // available to captain/organizer today (tbd_tournament_team only
        // blocks it once the tournament is Cancelled/CancelledMinTeams/
        // Finished), just applied at the cutoff instead of by hand. Late
        // registrations (checked_in_at already stamped by tbi_tournament_team
        // at insert time) are never touched here. This is the only lever
        // the existing seeding function (assign_seeds_to_teams) actually
        // respects -- it recomputes eligibility from live roster headcount
        // every time it runs, so nulling a flag without removing the
        // roster would just get silently re-eligible on the next call.
        const removed = await client.query<{ id: string }>(
          `DELETE FROM public.tournament_teams
           WHERE tournament_id = $1
             AND checked_in_at IS NULL
             AND created_at < (
               SELECT start - (attendance_check_in_open_before_minutes::text || ' minutes')::interval
               FROM public.tournaments WHERE id = $1
             )
           RETURNING id`,
          [tournamentId],
        );

        if (removed.rows.length > 0) {
          this.logger.log(
            `[${tournamentId}] removed ${removed.rows.length} no-show team(s) at tournament attendance cutoff`,
          );
        }
      }

      // Row-level atomic guard: only this transaction can win the
      // RegistrationOpen -> RegistrationClosed flip for this tournament, so
      // a racing manual "Close Registration" click and this scheduler tick
      // can't both act on it -- whichever commits first excludes the other
      // via the WHERE clause.
      const closed = await client.query<{ id: string }>(
        `UPDATE public.tournaments
         SET status = 'RegistrationClosed', individual_check_in_ends_at = NULL
         WHERE id = $1 AND status = 'RegistrationOpen'
         RETURNING id`,
        [tournamentId],
      );

      closedRegistration = closed.rows.length > 0;
    });

    if (!closedRegistration) {
      // A racing manual action already closed registration this tick --
      // nothing left for this job to do. Auto-generating teams here too
      // would be a second, unrequested action on top of whatever the
      // organizer just did manually.
      return;
    }

    if (tournament.individual_registration_enabled) {
      const teamSize =
        tournament.min_players_per_lineup || tournament.max_players_per_lineup;
      if (!teamSize || teamSize < 1) {
        this.logger.error(
          `[${tournamentId}] cannot auto-generate teams: no configured lineup size`,
        );
        return;
      }
      try {
        const result =
          await this.teamGeneration.generateTournamentTeamsForTournament(
            tournamentId,
            teamSize,
          );
        this.logger.log(
          `[${tournamentId}] auto-generated ${result.teamsCreated} team(s), ${result.waitlisted} left waitlisted`,
        );
      } catch (error) {
        this.logger.error(
          `[${tournamentId}] automatic team generation failed`,
          error,
        );
      }
    }
  }
}
