import { Controller, Logger } from "@nestjs/common";
import { PoolClient } from "pg";
import { HasuraAction, HasuraEvent } from "../hasura/hasura.controller";
import { HasuraService } from "../hasura/hasura.service";
import { HasuraEventData } from "../hasura/types/HasuraEventData";
import { DemoMetadataService } from "../demos/demo-metadata.service";
import { ClipsService } from "../matches/clips/clips.service";
import { User } from "../auth/types/User";
import { DiscordTournamentVoiceService } from "../discord-bot/discord-tournament-voice/discord-tournament-voice.service";
import { PostgresService } from "../postgres/postgres.service";
import { AwardsService } from "../awards/awards.service";
import { tournaments_set_input, e_notification_types_enum } from "../../generated";
import { NotificationsService } from "../notifications/notifications.service";

// These tables are newer than the generated GraphQL types; event payloads are
// typed locally (mirrors the leagues controller).
type TournamentOrganizerTeamRow = {
  tournament_id?: string;
  team_id?: string;
};

type TeamRosterRow = {
  team_id?: string;
  player_steam_id?: string;
  role?: string;
};

@Controller("tournaments")
export class TournamentsController {
  constructor(
    private readonly logger: Logger,
    private readonly hasura: HasuraService,
    private readonly demoMetadata: DemoMetadataService,
    private readonly clips: ClipsService,
    private readonly tournamentVoice: DiscordTournamentVoiceService,
    private readonly postgres: PostgresService,
    private readonly awards: AwardsService,
    private readonly notifications: NotificationsService,
  ) {}

  @HasuraEvent()
  public async tournament_events(data: HasuraEventData<tournaments_set_input>) {
    const tournamentId = (data.new.id || data.old.id) as string;
    const status = data.new.status as string;

    // "Created" from a player's point of view is really "opened up for
    // signups" -- broadcasting on the raw table INSERT would announce
    // tournaments an organizer is still mid-setup on (they start in
    // Setup and get configured before ever being made public).
    if (status === "RegistrationOpen" && data.old.status !== "RegistrationOpen") {
      const name = NotificationsService.escapeHtml(
        (data.new.name as string) ?? "A tournament",
      );
      const start = data.new.start
        ? new Date(data.new.start as unknown as string).toUTCString()
        : undefined;
      await this.notifications.send(
        "TournamentCreated" as unknown as e_notification_types_enum,
        {
          title: "New tournament",
          message: start
            ? `<b>${name}</b> is open for signups — starts ${start}.`
            : `<b>${name}</b> is open for signups.`,
          role: "user",
          entity_id: tournamentId,
        },
      );
    }

    if (status === "Live" && data.old.status !== "Live") {
      await this.tournamentVoice.createTournamentReadyRoom(tournamentId);
    }

    if (["Finished", "Cancelled", "CancelledMinTeams"].includes(status)) {
      await this.tournamentVoice.removeTournamentVoice(tournamentId);
    }

    // Cancelling resets the bracket: drop the matches (and their demos) so
    // they can be regenerated. The bracket rows are first detached (their
    // match_id set to NULL) rather than left in place for an FK cascade, then
    // the matches themselves are deleted -- the same atomic helper
    // deleteTournament uses. S3 cleanup runs afterward, best-effort.
    if (status === "Cancelled" && data.old.status !== "Cancelled") {
      const deletedMatchIds = await this.postgres.transaction((client) =>
        this.deleteTournamentMatchRows(client, tournamentId),
      );
      await this.purgeMatchAssets(tournamentId, deletedMatchIds);
      this.logger.log(
        `[${tournamentId}] tournament cancelled, cleaned up assets across ${deletedMatchIds.length} matches`,
      );
    }
  }

  // Fired when an organisation team is linked to / unlinked from a tournament.
  // Linking expands every accepted member of the team into tournament_organizers;
  // unlinking removes the organizers that link contributed.
  @HasuraEvent()
  public async tournament_organizer_team_events(
    data: HasuraEventData<TournamentOrganizerTeamRow>,
  ) {
    const tournamentId = (data.new?.tournament_id ||
      data.old?.tournament_id) as string;
    const teamId = (data.new?.team_id || data.old?.team_id) as string;

    if (!tournamentId || !teamId) {
      return;
    }

    if (data.op === "DELETE") {
      await this.removeOrganizationTeamOrganizers(tournamentId, teamId);
      await this.syncRemainingOrganizationTeams(tournamentId);
      return;
    }

    await this.syncOrganizationTeamOrganizers(tournamentId, teamId);
  }

  // A tournament_organizers row carries a single organization_team_id, so someone
  // on two linked org teams is only ever tagged with the first. Unlinking that team
  // drops them even though the other team still entitles them, so re-sync whatever
  // links remain to put them back.
  private async syncRemainingOrganizationTeams(tournamentId: string) {
    const { tournament_organizer_teams } = await this.hasura.query({
      tournament_organizer_teams: {
        __args: {
          where: { tournament_id: { _eq: tournamentId } },
        },
        team_id: true,
      },
    });

    for (const link of tournament_organizer_teams) {
      await this.syncOrganizationTeamOrganizers(tournamentId, link.team_id);
    }
  }

  // Fired when a team's roster changes. Re-syncs organizers for every tournament
  // that uses this team as an organisation team so additions/removals propagate.
  @HasuraEvent()
  public async tournament_org_roster_events(
    data: HasuraEventData<TeamRosterRow>,
  ) {
    const teamId = (data.new?.team_id || data.old?.team_id) as string;

    if (!teamId) {
      return;
    }

    const { tournament_organizer_teams } = await this.hasura.query({
      tournament_organizer_teams: {
        __args: {
          where: { team_id: { _eq: teamId } },
        },
        tournament_id: true,
      },
    });

    // Sync the changed team first (it performs the removals), then the
    // tournament's other links: a removed member tagged with this team may
    // still be entitled by another linked team, which must re-add them.
    for (const link of tournament_organizer_teams) {
      await this.syncOrganizationTeamOrganizers(link.tournament_id, teamId);
      await this.syncRemainingOrganizationTeams(link.tournament_id);
    }
  }

  // Every roster member of an organisation team. A team_roster row is already an
  // accepted member -- pending invites live in team_invites, and e_team_roles
  // ("Member" / "Invite" / "Admin") describes roster powers, not invite state, so
  // filtering on role here would silently drop real members.
  private async getOrganizationTeamSteamIds(teamId: string): Promise<string[]> {
    const { team_roster } = await this.hasura.query({
      team_roster: {
        __args: {
          where: {
            team_id: { _eq: teamId },
          },
        },
        player_steam_id: true,
      },
    });

    return team_roster.map((member) => String(member.player_steam_id));
  }

  private async syncOrganizationTeamOrganizers(
    tournamentId: string,
    teamId: string,
  ) {
    const steamIds = await this.getOrganizationTeamSteamIds(teamId);

    const { tournament_organizers: existing } = await this.hasura.query({
      tournament_organizers: {
        __args: {
          where: { tournament_id: { _eq: tournamentId } },
        },
        steam_id: true,
      },
    });

    const existingSteamIds = new Set(
      existing.map((organizer) => String(organizer.steam_id)),
    );
    const toInsert = steamIds.filter(
      (steamId) => !existingSteamIds.has(steamId),
    );

    if (toInsert.length > 0) {
      // on_conflict: concurrent events for the same tournament race between the
      // read above and this insert; the PK hit must not fail the whole batch.
      await this.hasura.mutation({
        insert_tournament_organizers: {
          __args: {
            objects: toInsert.map((steam_id) => ({
              steam_id,
              tournament_id: tournamentId,
              organization_team_id: teamId,
            })),
            on_conflict: {
              constraint: "tournament_organizers_pkey",
              update_columns: [],
            },
          },
          affected_rows: true,
        },
      });
    }

    // Drop organizers this team previously contributed who are no longer on its
    // roster. Manually-added organizers (organization_team_id IS NULL) are left
    // untouched.
    await this.hasura.mutation({
      delete_tournament_organizers: {
        __args: {
          where: {
            tournament_id: { _eq: tournamentId },
            organization_team_id: { _eq: teamId },
            ...(steamIds.length > 0 ? { steam_id: { _nin: steamIds } } : {}),
          },
        },
        affected_rows: true,
      },
    });
  }

  private async removeOrganizationTeamOrganizers(
    tournamentId: string,
    teamId: string,
  ) {
    await this.hasura.mutation({
      delete_tournament_organizers: {
        __args: {
          where: {
            tournament_id: { _eq: tournamentId },
            organization_team_id: { _eq: teamId },
          },
        },
        affected_rows: true,
      },
    });
  }

  @HasuraAction()
  public async deleteTournament(data: { user: User; tournament_id: string }) {
    const { tournament_id } = data;
    this.logger.log(`[${tournament_id}] deleting tournament`);

    // Query with user context for authorization checks
    const { tournaments_by_pk } = await this.hasura.query(
      {
        tournaments_by_pk: {
          __args: {
            id: tournament_id,
          },
          id: true,
          status: true,
          is_organizer: true,
        },
      },
      data.user.steam_id,
    );

    if (!tournaments_by_pk) {
      throw Error("tournament not found");
    }

    if (!tournaments_by_pk.is_organizer) {
      throw Error("not the tournament organizer");
    }

    if (tournaments_by_pk.status === "Live") {
      throw Error("cannot delete a live tournament");
    }

    const {
      league_season_divisions_aggregate,
      league_relegation_playoffs_aggregate,
    } = await this.hasura.query({
      league_season_divisions_aggregate: {
        __args: { where: { tournament_id: { _eq: tournament_id } } },
        aggregate: { count: true },
      },
      league_relegation_playoffs_aggregate: {
        __args: { where: { tournament_id: { _eq: tournament_id } } },
        aggregate: { count: true },
      },
    });

    if (
      league_season_divisions_aggregate.aggregate.count > 0 ||
      league_relegation_playoffs_aggregate.aggregate.count > 0
    ) {
      throw Error(
        "cannot delete a tournament that belongs to a league; manage it from the league instead",
      );
    }

    // One PostgreSQL transaction, SQL only. Order matters:
    //  1. award recipients (ON DELETE RESTRICT against award_occurrences)
    //  2. award occurrences scoped to this tournament
    //  3. this tournament's match rows, via deleteTournamentMatchRows -- see
    //     its comment for why bracket rows must be detached (match_id set to
    //     NULL) *before* the matches are deleted, rather than deleting
    //     matches first and leaving the tournament cascade to trip the
    //     tournament_brackets BEFORE DELETE trigger.
    //  4. the tournament row itself, RETURNING id to confirm exactly one row
    //     was removed.
    // Everything else tournament- or match-owned is left to the existing FK
    // cascades. Reusable/unscoped award definitions in `awards` are untouched,
    // and no Hasura mutation is called from inside this callback.
    let deletedMatchIds: string[] = [];
    await this.postgres.transaction(async (client) => {
      await this.awards.deleteTournamentAwardRecords(client, tournament_id);
      deletedMatchIds = await this.deleteTournamentMatchRows(
        client,
        tournament_id,
      );

      const deleted = await client.query<{ id: string }>(
        `DELETE FROM public.tournaments WHERE id = $1 RETURNING id`,
        [tournament_id],
      );
      if (deleted.rows.length !== 1) {
        throw Error(
          `expected to delete exactly one tournament row, deleted ${deleted.rows.length}`,
        );
      }
    });

    // Best-effort S3 purge after the commit above. Every match/demo/clip
    // database row is already gone as part of the transaction (matches
    // cascades into match_maps -> match_clips, player stat tables,
    // event_match_links, etc.; match_map_demos was deleted explicitly).
    // clips.deleteClipsForMatch / demoMetadata.deleteDemosForMatch still look
    // up their own rows via Hasura first, but those lookups now find nothing,
    // so only their S3 prefix sweeps do real work here -- no
    // delete_matches_by_pk (or any other DB delete) is issued after commit.
    // A failure here must not be reported as a failed tournament deletion.
    await this.purgeMatchAssets(tournament_id, deletedMatchIds);

    this.logger.log(
      `[${tournament_id}] tournament deleted, cleaned up assets across ${deletedMatchIds.length} matches`,
    );

    return {
      success: true,
    };
  }

  // Individual sign-up (match_options.individual_registration_enabled):
  // ELO-balances everyone in tournament_individual_signups into fresh,
  // ad-hoc tournament_teams (team_id left NULL, same as a brand-new
  // tournament-only team created via the normal join form). Snake-draft
  // order across the generated teams -- sort by ELO (shuffled first, so
  // players tied/close in ELO land in random relative order, matching the
  // "random but balanced" request), then deal round 1 team1..teamN, round 2
  // teamN..team1, etc. Same spirit as DraftService.autoSplit's "always give
  // the next player to whichever side needs one" greedy fill, generalized
  // from 2 sides to N.
  //
  // Leftover players (registered count not evenly divisible by team size)
  // are marked Waitlisted rather than forced onto an undersized team.
  @HasuraAction()
  public async generateTournamentTeams(data: {
    user: User;
    tournament_id: string;
  }) {
    const { tournament_id } = data;

    const { tournaments_by_pk: tournament } = await this.hasura.query(
      {
        tournaments_by_pk: {
          __args: { id: tournament_id },
          id: true,
          status: true,
          is_organizer: true,
          min_players_per_lineup: true,
          max_players_per_lineup: true,
          options: {
            individual_registration_enabled: true,
          },
        },
      },
      data.user.steam_id,
    );

    if (!tournament) {
      throw Error("tournament not found");
    }
    if (!tournament.is_organizer) {
      throw Error("not the tournament organizer");
    }
    if (!tournament.options?.individual_registration_enabled) {
      throw Error("individual registration is not enabled for this tournament");
    }
    if (tournament.status !== "RegistrationClosed") {
      throw Error("registration must be closed before generating teams");
    }

    const teamSize =
      tournament.min_players_per_lineup || tournament.max_players_per_lineup;
    if (!teamSize || teamSize < 1) {
      throw Error("tournament has no configured lineup size");
    }

    const { tournament_individual_signups: signups } = await this.hasura.query({
      tournament_individual_signups: {
        __args: {
          where: {
            tournament_id: { _eq: tournament_id },
            status: { _eq: "Registered" },
          },
        },
        id: true,
        player_steam_id: true,
        player: {
          name: true,
          elo: true,
        },
      },
    });

    if (!signups?.length) {
      throw Error("no individually-registered players to generate teams from");
    }

    // wingman = 2v2, everything else (competitive 5v5, etc.) uses the
    // competitive ladder -- there's no third team-size bracket today.
    const eloKey = teamSize === 2 ? "wingman" : "competitive";

    const shuffled = TournamentsController.shuffle(signups);
    const ranked = shuffled
      .map((signup) => ({
        signupId: signup.id as string,
        steamId: String(signup.player_steam_id),
        name: (signup.player?.name as string) ?? null,
        elo: Number((signup.player?.elo as Record<string, number>)?.[eloKey] ?? 5000),
      }))
      .sort((a, b) => b.elo - a.elo);

    const teamCount = Math.floor(ranked.length / teamSize);
    if (teamCount < 1) {
      throw Error(
        `not enough registered players (${ranked.length}) for a single ${teamSize}-player team`,
      );
    }

    const assignedCount = teamCount * teamSize;
    const waitlisted = ranked.slice(assignedCount);
    const toAssign = ranked.slice(0, assignedCount);

    // Snake draft across teamCount teams.
    const teams: Array<typeof toAssign> = Array.from(
      { length: teamCount },
      (): typeof toAssign => [],
    );
    let round = 0;
    let index = 0;
    while (index < toAssign.length) {
      const order =
        round % 2 === 0
          ? Array.from({ length: teamCount }, (_, i) => i)
          : Array.from({ length: teamCount }, (_, i) => teamCount - 1 - i);
      for (const teamIndex of order) {
        if (index >= toAssign.length) break;
        teams[teamIndex].push(toAssign[index]);
        index++;
      }
      round++;
    }

    await this.postgres.transaction(async (client) => {
      for (const [teamIndex, roster] of teams.entries()) {
        // Highest-ELO player on the generated roster stands in as
        // owner/captain -- there's no "team owner" concept for a pool of
        // strangers auto-assigned together, this just satisfies
        // tournament_teams.owner_steam_id NOT NULL with a defensible pick.
        const captain = roster[0];
        const teamRow = await client.query<{ id: string }>(
          `INSERT INTO public.tournament_teams
             (tournament_id, name, owner_steam_id, captain_steam_id, team_id)
           VALUES ($1, $2, $3, $3, NULL)
           RETURNING id`,
          [
            tournament_id,
            `Team ${teamIndex + 1}`,
            captain.steamId,
          ],
        );
        const tournamentTeamId = teamRow.rows[0].id;

        for (const player of roster) {
          await client.query(
            `INSERT INTO public.tournament_team_roster
               (tournament_team_id, player_steam_id, tournament_id)
             VALUES ($1, $2, $3)`,
            [tournamentTeamId, player.steamId, tournament_id],
          );
          await client.query(
            `UPDATE public.tournament_individual_signups
             SET status = 'Assigned', tournament_team_id = $1
             WHERE id = $2`,
            [tournamentTeamId, player.signupId],
          );
        }
      }

      if (waitlisted.length) {
        await client.query(
          `UPDATE public.tournament_individual_signups
           SET status = 'Waitlisted'
           WHERE id = ANY($1::uuid[])`,
          [waitlisted.map((player) => player.signupId)],
        );
      }
    });

    this.logger.log(
      `[${tournament_id}] generated ${teamCount} team(s) (${assignedCount} players) from individual sign-ups, ${waitlisted.length} waitlisted`,
    );

    return {
      teamsCreated: teamCount,
      waitlisted: waitlisted.length,
    };
  }

  // Opens (or re-opens) a check-in window for everyone currently
  // Registered -- resets checked_in_at so a re-opened window (eg. the
  // automatic re-open ProcessTournamentCheckInExpiry does after promoting
  // waitlisted players) starts every affected player fresh, not carrying
  // over a check-in from a previous round they were never part of.
  @HasuraAction()
  public async startTournamentIndividualCheckIn(data: {
    user: User;
    tournament_id: string;
    duration_minutes: number;
  }) {
    const { tournament_id, duration_minutes } = data;
    if (!Number.isFinite(duration_minutes) || duration_minutes < 1) {
      throw Error("duration_minutes must be at least 1");
    }

    const { tournaments_by_pk: tournament } = await this.hasura.query(
      {
        tournaments_by_pk: {
          __args: { id: tournament_id },
          id: true,
          is_organizer: true,
          status: true,
          options: { individual_registration_enabled: true },
        },
      },
      data.user.steam_id,
    );

    if (!tournament) {
      throw Error("tournament not found");
    }
    if (!tournament.is_organizer) {
      throw Error("not the tournament organizer");
    }
    if (!tournament.options?.individual_registration_enabled) {
      throw Error("individual registration is not enabled for this tournament");
    }
    if (tournament.status !== "RegistrationClosed") {
      throw Error("registration must be closed before starting check-in");
    }

    const endsAt = new Date(Date.now() + duration_minutes * 60_000);

    await this.postgres.query(
      `UPDATE public.tournaments
       SET individual_check_in_ends_at = $1, individual_check_in_duration_minutes = $2
       WHERE id = $3`,
      [endsAt, duration_minutes, tournament_id],
    );
    await this.postgres.query(
      `UPDATE public.tournament_individual_signups
       SET checked_in_at = NULL
       WHERE tournament_id = $1 AND status = 'Registered'`,
      [tournament_id],
    );

    this.logger.log(
      `[${tournament_id}] individual check-in window opened, ${duration_minutes}m`,
    );

    return { success: true };
  }

  @HasuraAction()
  public async checkIntoTournament(data: { user: User; tournament_id: string }) {
    const { tournament_id } = data;

    const { tournaments_by_pk: tournament } = await this.hasura.query({
      tournaments_by_pk: {
        __args: { id: tournament_id },
        id: true,
        individual_check_in_ends_at: true,
      },
    });

    if (!tournament) {
      throw Error("tournament not found");
    }
    if (
      !tournament.individual_check_in_ends_at ||
      new Date(tournament.individual_check_in_ends_at as unknown as string) <=
        new Date()
    ) {
      throw Error("check-in is not currently open for this tournament");
    }

    const updated = await this.postgres.query<Array<{ id: string }>>(
      `UPDATE public.tournament_individual_signups
       SET checked_in_at = now()
       WHERE tournament_id = $1 AND player_steam_id = $2 AND status = 'Registered'
       RETURNING id`,
      [tournament_id, data.user.steam_id],
    );

    if (!updated.length) {
      throw Error("you are not registered (or not currently eligible to check in)");
    }

    return { success: true };
  }

  private static shuffle<T>(items: Array<T>): Array<T> {
    const result = [...items];
    for (let index = result.length - 1; index > 0; index--) {
      const swap = Math.floor(Math.random() * (index + 1));
      const temp = result[index];
      result[index] = result[swap];
      result[swap] = temp;
    }
    return result;
  }

  // Deletes this tournament's match rows through the supplied transaction
  // client, using only parameterized SQL, and returns the match ids that
  // were actually deleted (for the post-commit S3 purge).
  //
  // Order, and why it matters:
  //  1. Detach -- lock this tournament's own tournament_brackets rows
  //     (FOR UPDATE, so a concurrent bracket change can't race the detach)
  //     and set match_id = NULL on the ones that still point at a match,
  //     capturing the previous match ids via RETURNING. match_id is nullable
  //     with no other constraint depending on it (confirmed: no CHECK/UNIQUE
  //     references tournament_brackets.match_id), so this is always safe.
  //     tournament_brackets' own BEFORE DELETE trigger
  //     (tbd_tournament_brackets) only fires `DELETE FROM matches WHERE id =
  //     OLD.match_id` when `OLD.match_id IS NOT NULL` -- with match_id
  //     already NULL by the time the tournament's cascade reaches these
  //     bracket rows, that delete becomes an unconditional no-op, so it can
  //     never fire matches' own AFTER DELETE trigger (tad_matches) again
  //     during the cascade.
  //  2. Deleting the matches *here*, explicitly and before the tournament
  //     row, means tad_matches (which calls
  //     calculate_tournament_bracket_start_times, updating sibling
  //     tournament_brackets rows) runs while the tournament and its brackets
  //     are still in their ordinary, non-cascading state -- not while
  //     tournament_stages/tournament_brackets are already mid-cascade-delete
  //     from `DELETE FROM tournaments` below. That ordering is exactly what
  //     previously produced "tuple to be deleted was already modified by an
  //     operation triggered by the current command" when matches were left
  //     for the tournament cascade (via the bracket trigger) to clean up.
  //  3. match_map_demos -- match_map_demos.match_id references matches(id)
  //     ON DELETE RESTRICT (as does match_map_demos.match_map_id against
  //     match_maps(id)), so demo rows must go before the match delete or it
  //     fails outright.
  //  4. matches -- everything else a match owns (match_maps and, through it,
  //     match_clips; per-round/per-player stat tables; event_match_links;
  //     match_player_disconnects; ...) is ON DELETE CASCADE from matches(id)
  //     and cleans up automatically. The delete carries a NOT EXISTS
  //     safeguard: the schema does not enforce one bracket per match, so a
  //     match is only removed once no tournament_brackets row anywhere (not
  //     just this tournament's, already detached in step 1) still points at
  //     it -- a match shared with, or actually owned by, another tournament
  //     is left alone.
  // Ids are deduplicated by the `SELECT DISTINCT` in the detach query, so a
  // match referenced by more than one of this tournament's own bracket rows
  // is only processed once.
  private async deleteTournamentMatchRows(
    client: PoolClient,
    tournamentId: string,
  ): Promise<string[]> {
    const detached = await client.query<{ match_id: string }>(
      `WITH owned_brackets AS (
         SELECT tb.id, tb.match_id
         FROM public.tournament_brackets tb
         JOIN public.tournament_stages ts ON ts.id = tb.tournament_stage_id
         WHERE ts.tournament_id = $1
           AND tb.match_id IS NOT NULL
         FOR UPDATE
       ),
       detached AS (
         UPDATE public.tournament_brackets tb
         SET match_id = NULL
         FROM owned_brackets ob
         WHERE tb.id = ob.id
         RETURNING ob.match_id
       )
       SELECT DISTINCT match_id FROM detached`,
      [tournamentId],
    );

    const candidateIds = detached.rows.map((row) => row.match_id);
    if (candidateIds.length === 0) {
      return [];
    }

    // Re-check *before* deleting anything match-owned: this tournament's own
    // references were just detached above, so if a candidate is still
    // referenced by any tournament_brackets row at all, that row belongs to
    // someone else. Skip it entirely -- including its match_map_demos, which
    // must stay intact for whichever bracket still owns it.
    const deletable = await client.query<{ id: string }>(
      `SELECT m.id FROM public.matches m
        WHERE m.id = ANY($1::uuid[])
          AND NOT EXISTS (
            SELECT 1 FROM public.tournament_brackets tb
            WHERE tb.match_id = m.id
          )`,
      [candidateIds],
    );
    const matchIds = deletable.rows.map((row) => row.id);
    if (matchIds.length === 0) {
      return [];
    }

    await client.query(
      `DELETE FROM public.match_map_demos WHERE match_id = ANY($1::uuid[])`,
      [matchIds],
    );

    await client.query(`DELETE FROM public.matches WHERE id = ANY($1::uuid[])`, [
      matchIds,
    ]);

    return matchIds;
  }

  // External S3 cleanup only, run after the owning transaction has already
  // committed (or, for the Cancelled-event path, after its own match-row
  // transaction commits). Each match is best-effort: one failure is logged
  // and does not stop the rest, and never throws back to the caller.
  private async purgeMatchAssets(
    tournamentId: string,
    matchIds: string[],
  ): Promise<void> {
    for (const matchId of matchIds) {
      try {
        await this.clips.deleteClipsForMatch(matchId);
        await this.demoMetadata.deleteDemosForMatch(matchId);
      } catch (error) {
        this.logger.error(
          `[${tournamentId}] failed to purge S3 assets for match ${matchId}`,
          error,
        );
      }
    }
  }
}
