// Adapted from 5Stack API c23d08084075e620387cebeabb2fa62e2b78f828.
// MIT Copyright (c) 2025 5Stack.gg; see LICENSE. DEAFCS eligibility and ELO apply.
// Shared tournament access and check-in logic. HTTP actions remain in controllers.
import { Injectable } from "@nestjs/common";
import { PostgresService } from "../postgres/postgres.service";
import { User } from "../auth/types/User";

export type TournamentAccess = {
  id: string;
  name: string;
  status: string;
  start: string;
  banner: string | null;
  logo: string | null;
  organizer_steam_id: string | null;
  registration_type: string;
  registration_version: number;
  individual_only: boolean;
  invite_only: boolean;
  check_in_required: boolean;
  check_in_setting: string;
  check_in_open: boolean;
  is_organizer: boolean;
  unlocked: boolean;
};

type CheckInTeam = {
  id: string;
  can_manage: boolean;
  is_captain: boolean;
};

@Injectable()
export class TournamentRegistrationService {
  constructor(private readonly postgres: PostgresService) {}

  private hasuraSession(user: User): string {
    return JSON.stringify({"x-hasura-role": user.role, "x-hasura-user-id": user.steam_id});
  }

  public async getTournamentAccess(
    tournamentId: string,
    user: User,
  ): Promise<TournamentAccess> {
    const [tournament] = await this.postgres.query<Array<TournamentAccess>>(
      `SELECT t.id::text AS id,
              t.name,
              t.status,
              t."start",
              t.banner,
              t.logo,
              t.organizer_steam_id::text AS organizer_steam_id,
              t.registration_type,
              t.registration_version,
              COALESCE(mo.individual_registration_enabled, false) AS individual_only,
              t.invite_only,
              t.check_in_required,
              t.check_in_setting,
              COALESCE(tournament_check_in_open(t), false) AS check_in_open,
              COALESCE(is_tournament_organizer(t, $2::json), false) AS is_organizer,
              tournament_registration_unlocked(t.id, $3::bigint) AS unlocked
         FROM tournaments t
         JOIN match_options mo ON mo.id = t.match_options_id
        WHERE t.id = $1::uuid`,
      [tournamentId, this.hasuraSession(user), user.steam_id],
    );

    if (!tournament) {
      throw Error("tournament not found");
    }

    if (tournament.registration_version !== 2) {
      throw Error("this tournament uses historical registration");
    }
    return tournament;
  }

  private requireOrganizer(tournament: TournamentAccess) {
    if (!tournament.is_organizer) {
      throw Error("not the tournament organizer");
    }
  }

  public async checkIntoTournament(data: {
    user: User;
    tournament_id: string;
    tournament_team_id?: string;
  }) {
    const { tournament_id, tournament_team_id } = data;
    const tournament = await this.getTournamentAccess(tournament_id, data.user);

    if (!tournament.check_in_required) {
      throw Error("this tournament does not require check-in");
    }

    if (!tournament.check_in_open) {
      throw Error("the check-in window is not open");
    }

    const team = await this.resolveCheckInTeam(
      tournament_id,
      tournament_team_id,
      data.user,
    );

    // An undrafted free agent has no team to confirm for; their own row is the
    // whole confirmation, whatever check_in_setting says. Checked only after
    // the team lookup, so a free agent who has since been drafted (or joined a
    // team in a 'both' tournament) still confirms through that team.
    if (!team) {
      const freeAgent = await this.postgres.query<Array<{ id: string }>>(
        `UPDATE tournament_free_agents
            SET checked_in_at = now()
          WHERE tournament_id = $1::uuid
            AND player_steam_id = $2::bigint
            AND status <> 'withdrawn'
        RETURNING id::text AS id`,
        [tournament_id, data.user.steam_id],
      );

      if (freeAgent.length === 0) {
        throw Error("you are not registered for this tournament");
      }

      return { success: true };
    }

    switch (tournament.check_in_setting) {
      case "Admin": {
        this.requireOrganizer(tournament);
        break;
      }
      case "Players": {
        const confirmed = await this.postgres.query<Array<{ id: string }>>(
          `UPDATE tournament_team_roster
              SET checked_in_at = now()
            WHERE tournament_team_id = $1::uuid
              AND player_steam_id = $2::bigint
          RETURNING tournament_team_id::text AS id`,
          [team.id, data.user.steam_id],
        );

        if (confirmed.length === 0) {
          throw Error("you are not on this team's roster");
        }

        // taiud_tournament_team_roster_check_in rolls the per-player stamps up
        // into the team once the minimum lineup has confirmed.
        return { success: true };
      }
      default: {
        if (!team.can_manage && !team.is_captain) {
          throw Error(
            "only the team captain or a team admin can check this team in",
          );
        }
        break;
      }
    }

    await this.postgres.query(
      `UPDATE tournament_teams
          SET checked_in_at = now()
        WHERE id = $1::uuid
          AND tournament_id = $2::uuid
          AND checked_in_at IS NULL`,
      [team.id, tournament_id],
    );

    return { success: true };
  }

  private async resolveCheckInTeam(
    tournamentId: string,
    tournamentTeamId: string | undefined,
    user: User,
  ): Promise<CheckInTeam | undefined> {
    const session = this.hasuraSession(user);

    if (tournamentTeamId) {
      const [team] = await this.postgres.query<Array<CheckInTeam>>(
        `SELECT tt.id::text AS id,
                COALESCE(can_manage_tournament_team(tt, $3::json), false) AS can_manage,
                tt.captain_steam_id = $4::bigint OR tt.owner_steam_id = $4::bigint AS is_captain
           FROM tournament_teams tt
          WHERE tt.id = $1::uuid AND tt.tournament_id = $2::uuid`,
        [tournamentTeamId, tournamentId, session, user.steam_id],
      );

      if (!team) {
        throw Error("team is not registered for this tournament");
      }

      return team;
    }

    // The team they are ROSTERED on wins, and only then one they merely own or
    // captain: a player holds at most one roster row per tournament
    // (tournament_roster_pkey), and Players mode confirms that row and nothing
    // else. Ordered all the way down to the id, because an unordered LIMIT 1
    // over an owner who is also somebody else's substitute can answer
    // differently between two calls and check in the wrong team.
    const [team] = await this.postgres.query<Array<CheckInTeam>>(
      `SELECT tt.id::text AS id,
              COALESCE(can_manage_tournament_team(tt, $2::json), false) AS can_manage,
              tt.captain_steam_id = $3::bigint OR tt.owner_steam_id = $3::bigint AS is_captain
         FROM tournament_teams tt
         LEFT JOIN tournament_team_roster ttr
                ON ttr.tournament_team_id = tt.id
               AND ttr.player_steam_id = $3::bigint
        WHERE tt.tournament_id = $1::uuid
          AND (
              ttr.player_steam_id IS NOT NULL
              OR tt.owner_steam_id = $3::bigint
              OR tt.captain_steam_id = $3::bigint
          )
        ORDER BY (ttr.player_steam_id IS NOT NULL) DESC,
                 (tt.captain_steam_id = $3::bigint OR tt.owner_steam_id = $3::bigint) DESC,
                 tt.created_at,
                 tt.id
        LIMIT 1`,
      [tournamentId, session, user.steam_id],
    );

    return team;
  }

}
