// Adapted from 5Stack API c23d08084075e620387cebeabb2fa62e2b78f828.
// MIT Copyright (c) 2025 5Stack.gg; see LICENSE. DEAFCS eligibility and ELO apply.
import { Controller, Logger } from "@nestjs/common";
import { TournamentRegistrationService, TournamentAccess } from "./tournament-registration.service";
import { Redis } from "ioredis";
import { HasuraAction } from "../hasura/hasura.controller";
import { PostgresService } from "../postgres/postgres.service";
import { NotificationsService } from "../notifications/notifications.service";
import { RedisManagerService } from "../redis/redis-manager/redis-manager.service";
import { TermsService } from "../terms/terms.service";
import { User } from "../auth/types/User";
import { e_notification_types_enum } from "../../generated";

// One accepted member of the lobby being signed up as a free agent party, with
// every gate the pool applies to them resolved in the same round trip.
type LobbyPartyMember = {
  steam_id: string;
  name: string;
  eligible: boolean;
  unlocked: boolean;
  rostered: boolean;
  owns_team: boolean;
  pool_status: string | null;
};

@Controller("tournament-registration")
export class TournamentRegistrationController {
  private readonly redis: Redis;
  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    private readonly notifications: NotificationsService,
    private readonly redisManager: RedisManagerService,
    private readonly terms: TermsService,
    private readonly registration: TournamentRegistrationService,
  ) {
    this.redis = this.redisManager.getConnection();
  }

  private hasuraSession(user: User): string {
    return JSON.stringify({"x-hasura-role": user.role, "x-hasura-user-id": user.steam_id});
  }

  private async assertInviteRateLimit(options: {key: string; steamId: string; limit: number; message: string}) {
    const key = options.key + ":" + options.steamId;
    const attempts = Number(await this.redis.eval(
      "local n = redis.call('INCR', KEYS[1]); if n == 1 then redis.call('EXPIRE', KEYS[1], 60) end; return n",
      1, key,
    ));
    if (attempts > options.limit) throw Error(options.message);
  }
  private async getTournamentAccess(tournamentId: string, user: User): Promise<TournamentAccess> {
    return this.registration.getTournamentAccess(tournamentId, user);
  }

  private requireOrganizer(tournament: TournamentAccess) {
    if (!tournament.is_organizer) {
      throw Error("not the tournament organizer");
    }
  }

  // The bracket is drawn and matches may already be in play; re-admitting or
  // re-drafting into it is a different, much riskier feature.
  private static readonly BRACKET_IN_PLAY = [
    "Live",
    "Paused",
    "Finished",
    "Cancelled",
    "CancelledMinTeams",
  ];

  @HasuraAction()
  public async readmitTournamentTeam(data: {
    user: User;
    tournament_id: string;
    tournament_team_id: string;
  }) {
    const { tournament_id, tournament_team_id } = data;
    const tournament = await this.getTournamentAccess(tournament_id, data.user);

    this.requireOrganizer(tournament);

    if (TournamentRegistrationController.BRACKET_IN_PLAY.includes(tournament.status)) {
      throw Error("cannot re-admit a team once the tournament is live");
    }

    const readmitted = await this.postgres.query<Array<{ id: string }>>(
      `UPDATE tournament_teams
          SET checked_in_at = now()
        WHERE id = $1::uuid AND tournament_id = $2::uuid
      RETURNING id::text AS id`,
      [tournament_team_id, tournament_id],
    );

    if (readmitted.length === 0) {
      throw Error("team is not registered for this tournament");
    }

    await this.reseedTournament(tournament_id);

    this.logger.log(
      `[${tournament_id}] re-admitted team ${tournament_team_id} after a missed check-in`,
    );

    return { success: true };
  }

  @HasuraAction()
  public async extendTournamentCheckIn(data: {
    user: User;
    tournament_id: string;
    minutes: number;
  }) {
    const { tournament_id, minutes } = data;
    const tournament = await this.getTournamentAccess(tournament_id, data.user);

    this.requireOrganizer(tournament);

    if (tournament.status !== "CheckInReview") {
      throw Error("the tournament is not held for check-in review");
    }

    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 240) {
      throw Error("extend the check-in window by 1 to 240 minutes");
    }

    // Measured from now, not from the deadline that already passed: a review is
    // only reached after the cutoff, so extending "by 10 minutes" from a stale
    // deadline could still land in the past.
    //
    // The status stays CheckInReview. Flipping it back to RegistrationOpen was
    // what re-opened the window, but it also re-opened REGISTRATION -- Hasura's
    // insert rules key off exactly that status -- so an extension meant for two
    // missing teams enlarged the field with brand new ones, each auto-stamped as
    // checked in by tbi_tournament_team. Moving the deadline is enough on its
    // own: check-in is gated on the clock, and ProcessTournamentCheckIn closes
    // any deadline it has not already closed.
    const extended = await this.postgres.query<Array<{ id: string }>>(
      `UPDATE tournaments t
          SET check_in_ends_at = GREATEST(t.check_in_ends_at, now()) + make_interval(mins => $2::int)
        WHERE t.id = $1::uuid
          AND t.status = 'CheckInReview'
          AND GREATEST(t.check_in_ends_at, now()) + make_interval(mins => $2::int) < t."start"
      RETURNING t.id::text AS id`,
      [tournament_id, minutes],
    );

    if (extended.length === 0) {
      throw Error(
        "the extended check-in window would end after the tournament starts",
      );
    }

    const recipients = await this.pendingCheckInRecipients(tournament_id);

    if (recipients.length > 0) {
      await this.notifications.notifyPlayers("TournamentCheckInOpen" as e_notification_types_enum, {
        title: "Tournament check-in re-opened",
        message: `<a href="/tournaments/${tournament_id}"><b>${NotificationsService.escapeHtml(
          tournament.name,
        )}</b></a> check-in has been extended by ${minutes} minutes. Confirm your spot.`,
        role: "user",
        entity_id: tournament_id,
        steamIds: recipients,
      });
    }

    return { success: true };
  }

  // The same recipients the job announces the window to, from the same SQL:
  // an extension exists to rescue whoever has not confirmed, and free agents
  // waitlisted by the cutoff are the ones with the most to lose by not hearing
  // about it -- the draft re-admits exactly the waitlisted agents that checked
  // in.
  private async pendingCheckInRecipients(
    tournamentId: string,
  ): Promise<Array<string>> {
    const rows = await this.postgres.query<Array<{ steam_id: string }>>(
      `SELECT steam_id::text AS steam_id
         FROM tournament_pending_check_in_recipients($1::uuid)`,
      [tournamentId],
    );

    return rows.map((row) => row.steam_id);
  }

  @HasuraAction()
  public async continueTournamentCheckIn(data: {
    user: User;
    tournament_id: string;
  }) {
    const { tournament_id } = data;
    const tournament = await this.getTournamentAccess(tournament_id, data.user);

    this.requireOrganizer(tournament);

    if (tournament.status !== "CheckInReview") {
      throw Error("the tournament is not held for check-in review");
    }

    const continued = await this.postgres.query<Array<{ id: string }>>(
      `UPDATE tournaments
          SET status = 'RegistrationClosed'
        WHERE id = $1::uuid AND status = 'CheckInReview'
      RETURNING id::text AS id`,
      [tournament_id],
    );

    if (continued.length === 0) {
      throw Error("the tournament is no longer held for check-in review");
    }

    this.logger.log(
      `[${tournament_id}] continued out of check-in review without the missing teams`,
    );

    return { success: true };
  }

  @HasuraAction()
  public async draftTournamentTeams(data: {
    user: User;
    tournament_id: string;
  }) {
    const { tournament_id } = data;
    const tournament = await this.getTournamentAccess(tournament_id, data.user);

    this.requireOrganizer(tournament);

    if (TournamentRegistrationController.BRACKET_IN_PLAY.includes(tournament.status)) {
      throw Error("cannot draft teams once the tournament is live");
    }

    if (!["free_agents", "both"].includes(tournament.registration_type)) {
      throw Error("this tournament does not accept free agents");
    }

    const [drafted] = await this.postgres.query<
      Array<{ teams_created: number }>
    >(`SELECT draft_tournament_free_agent_teams($1::uuid) AS teams_created`, [
      tournament_id,
    ]);

    await this.reseedTournament(tournament_id);

    this.logger.log(
      `[${tournament_id}] drafted ${drafted.teams_created} free agent teams`,
    );

    return { teams_created: drafted.teams_created };
  }

  // All three, in this order. Stamping checked_in_at is not enough on its own:
  // assign_seeds_to_teams recomputes eligibility from scratch, the bracket is
  // SIZED by update_tournament_stages from the eligible count, and the slots are
  // filled by seed_stage. Run the seeding alone after "continue without them"
  // already drew the bracket and a re-admitted team gets eligible_at and a seed
  // with nowhere to play -- a seeded entrant that never appears in a match.
  //
  // Seeding runs FIRST because update_tournament_stages sizes the bracket from
  // eligible_at, and assign_seeds_to_teams is what writes it. The other way
  // round the bracket is built from the count as it stood before the re-admit,
  // so the team just let back in is seeded past the last slot that exists.
  private async reseedTournament(tournamentId: string) {
    await this.postgres.query(
      `SELECT assign_seeds_to_teams(t) FROM tournaments t WHERE t.id = $1::uuid`,
      [tournamentId],
    );
    await this.postgres.query(`SELECT update_tournament_stages($1::uuid)`, [
      tournamentId,
    ]);
    await this.postgres.query(
      `SELECT seed_stage(ts.id)
         FROM tournament_stages ts
        WHERE ts.tournament_id = $1::uuid AND ts."order" = 1`,
      [tournamentId],
    );
  }

  @HasuraAction()
  public async joinTournamentAsFreeAgent(data: {
    user: User;
    tournament_id: string;
    with_party?: boolean;
  }) {
    const { tournament_id } = data;
    const tournament = await this.getTournamentAccess(tournament_id, data.user);

    if (!["free_agents", "both"].includes(tournament.registration_type)) {
      throw Error("this tournament only accepts pre-formed teams");
    }

    if (tournament.status !== "RegistrationOpen") {
      throw Error("registration is not open");
    }

    this.requireRegistrationUnlocked(tournament);

    const [eligible] = await this.postgres.query<Array<{ ok: boolean }>>(
      `SELECT player_meets_tournament_requirements($1::uuid, $2::bigint) AS ok`,
      [tournament_id, data.user.steam_id],
    );

    if (!eligible?.ok) {
      throw Error("you do not meet this tournament's entry requirements");
    }

    await this.terms.assertAccepted(data.user.steam_id);
    if (data.with_party && tournament.individual_only) {
      throw Error("Random tournaments only accept individual Free Agents");
    }

    if (data.with_party) {
      return await this.joinFreeAgentPoolWithLobby(tournament, data.user);
    }

    await this.postgres.query(
      `INSERT INTO tournament_free_agents (tournament_id, player_steam_id)
       VALUES ($1::uuid, $2::bigint)
       ON CONFLICT (tournament_id, player_steam_id) DO NOTHING`,
      [tournament_id, data.user.steam_id],
    );

    return { success: true };
  }

  private static freeAgentPartyBlocker(
    member: LobbyPartyMember,
    requireUnlock: boolean,
  ): string | null {
    if (member.owns_team) {
      return "already has a team in this tournament";
    }

    if (member.rostered) {
      return "is already on a roster in this tournament";
    }

    if (!member.eligible) {
      return "does not meet this tournament's entry requirements";
    }

    // The invite-only gate is per player, like the passcode and the invite it
    // grants: the captain being unlocked says nothing about their friends.
    if (requireUnlock && !member.unlocked) {
      return "has not been invited to this tournament";
    }

    // Anything past 'registered' is a commitment the pool has already acted on
    // -- a draft has placed them, passed them over, or they were removed. Folding
    // such a row into a new party silently would build a party that the draft
    // then treats as smaller than the lobby that formed it.
    if (member.pool_status !== null && member.pool_status !== "registered") {
      return "is already committed in this tournament";
    }

    return null;
  }

  // Signing the lobby up IS the party: everyone accepted into it is entered
  // together under the lobby's id, and the draft keeps them on one team. There
  // is no invite to accept because there is nothing new to consent to -- the
  // captain already queues this exact roster into matchmaking, which commits
  // them to a live match rather than a signup.
  private async joinFreeAgentPoolWithLobby(
    tournament: TournamentAccess,
    user: User,
  ) {
    const [lobby] = await this.postgres.query<
      Array<{ lobby_id: string; captain: boolean }>
    >(
      `SELECT lobby_id::text AS lobby_id, captain
         FROM lobby_players
        WHERE steam_id = $1::bigint AND status = 'Accepted'`,
      [user.steam_id],
    );

    if (!lobby) {
      throw Error("you are not in a lobby");
    }

    if (!lobby.captain) {
      throw Error("you are not the captain of this lobby");
    }

    const members = await this.postgres.query<Array<LobbyPartyMember>>(
      `SELECT lp.steam_id::text AS steam_id,
              COALESCE(p.name, 'A player') AS name,
              player_meets_tournament_requirements($1::uuid, lp.steam_id) AS eligible,
              tournament_registration_unlocked($1::uuid, lp.steam_id) AS unlocked,
              EXISTS (
                  SELECT 1 FROM tournament_team_roster ttr
                   WHERE ttr.tournament_id = $1::uuid
                     AND ttr.player_steam_id = lp.steam_id
              ) AS rostered,
              EXISTS (
                  SELECT 1 FROM tournament_teams tt
                   WHERE tt.tournament_id = $1::uuid
                     AND tt.owner_steam_id = lp.steam_id
              ) AS owns_team,
              fa.status AS pool_status
         FROM lobby_players lp
         JOIN players p ON p.steam_id = lp.steam_id
    LEFT JOIN tournament_free_agents fa
           ON fa.tournament_id = $1::uuid AND fa.player_steam_id = lp.steam_id
        WHERE lp.lobby_id = $2::uuid AND lp.status = 'Accepted'
        ORDER BY lp.captain DESC, lp.steam_id`,
      [tournament.id, lobby.lobby_id],
    );

    if (members.length === 0) {
      throw Error("you are not in a lobby");
    }

    for (const member of members) {
      await this.terms.assertAccepted(member.steam_id);
    }
    const steamIds = members.map((member) => member.steam_id);

    for (const member of members) {
      const blocker = TournamentRegistrationController.freeAgentPartyBlocker(
        member,
        tournament.invite_only,
      );

      if (blocker) {
        throw Error(`${member.name} ${blocker}`);
      }
    }

    const [sizing] = await this.postgres.query<
      Array<{ team_size: number | null; carried_over: string }>
    >(
      `SELECT COALESCE(
                  tournament_min_players_per_lineup(t),
                  tournament_max_players_per_lineup(t)
              ) AS team_size,
              (
                  SELECT COUNT(*)
                    FROM tournament_free_agents fa
                   WHERE fa.tournament_id = t.id
                     AND fa.party_id = $2::uuid
                     AND fa.status <> 'withdrawn'
                     AND fa.player_steam_id <> ALL($3::bigint[])
              )::text AS carried_over
         FROM tournaments t
        WHERE t.id = $1::uuid`,
      [tournament.id, lobby.lobby_id, steamIds],
    );

    // Members who signed up from this lobby and have since left it still hold
    // the party's id, so the cap is measured on the pool rather than on the
    // lobby: a lobby that has churned can be larger than any team it drafts on.
    const partySize = members.length + Number(sizing?.carried_over ?? 0);
    const teamSize = sizing?.team_size ?? null;

    if (teamSize !== null && partySize > teamSize) {
      throw Error(
        `a party of ${partySize} cannot be drafted onto a team of ${teamSize}`,
      );
    }

    await this.postgres.query(
      `INSERT INTO tournament_free_agents (tournament_id, player_steam_id, party_id)
       SELECT $1::uuid, member.steam_id, $2::uuid
         FROM unnest($3::bigint[]) AS member(steam_id)
       ON CONFLICT (tournament_id, player_steam_id)
       DO UPDATE SET party_id = EXCLUDED.party_id
                WHERE tournament_free_agents.status = 'registered'`,
      [tournament.id, lobby.lobby_id, steamIds],
    );

    await this.announceFreeAgentParty(
      tournament,
      user,
      steamIds.filter((steamId) => steamId !== user.steam_id),
    );

    return { success: true };
  }

  private async announceFreeAgentParty(
    tournament: TournamentAccess,
    captain: User,
    steamIds: Array<string>,
  ) {
    if (steamIds.length === 0) {
      return;
    }

    try {
      await this.notifications.notifyPlayers("TournamentPartySignup" as e_notification_types_enum, {
        title: "Signed up with your lobby",
        message: `<b>${NotificationsService.escapeHtml(
          captain.name,
        )}</b> signed your lobby up for <a href="/tournaments/${
          tournament.id
        }"><b>${NotificationsService.escapeHtml(
          tournament.name,
        )}</b></a>. You will be drafted onto the same team.`,
        role: "user",
        entity_id: tournament.id,
        steamIds,
      });
    } catch (error) {
      // The signup is already written; a lost notification must not surface as
      // a failed registration to the captain who sent it.
      this.logger.warn(
        `[${tournament.id}] unable to announce free agent party`,
        error,
      );
    }
  }

  @HasuraAction()
  public async leaveTournamentAsFreeAgent(data: {
    user: User;
    tournament_id: string;
  }) {
    const { tournament_id } = data;
    const tournament = await this.getTournamentAccess(tournament_id, data.user);

    if (!["Setup", "RegistrationOpen"].includes(tournament.status)) {
      throw Error("the free agent pool is closed");
    }

    const removed = await this.postgres.query<
      Array<{ id: string; status: string }>
    >(
      `DELETE FROM tournament_free_agents
        WHERE tournament_id = $1::uuid AND player_steam_id = $2::bigint
      RETURNING id::text AS id, status`,
      [tournament_id, data.user.steam_id],
    );

    if (removed.length === 0) {
      throw Error("you are not in this tournament's free agent pool");
    }

    // Giving up a drafted slot drops the roster row and pulls the earliest
    // waitlisted agent into it (tad_tournament_free_agents). Both the team that
    // lost a player and the one that gained one need eligible_at and their seed
    // recomputed -- check_team_eligibility restores eligibility on the roster
    // write but never gives the seed back.
    if (removed[0].status === "drafted") {
      await this.reseedTournament(tournament_id);
    }

    return { success: true };
  }

  // Organizer controls over the free agent pool, before the draft. The pool
  // is frozen and drafted when registration closes, so only an open
  // registration (or a held check-in review, which has not drafted yet) can be
  // edited; a drafted entry is a member of a generated team and is changed
  // through that team's roster, never through the pool. Authorization is the
  // tournament's organizers, co-organizers and site administrators
  // (is_tournament_organizer); eligibility, the one-roster rule, invite access
  // and the party rules are the same triggers a self-registration runs.
  private static readonly FREE_AGENT_POOL_EDITABLE = [
    "RegistrationOpen",
    "CheckInReview",
  ];

  @HasuraAction()
  public async addTournamentFreeAgent(data: {
    user: User;
    tournament_id: string;
    player_steam_id: string;
  }) {
    const { tournament_id } = data;
    const player_steam_id = String(data.player_steam_id);
    const tournament = await this.getTournamentAccess(tournament_id, data.user);

    this.requireOrganizer(tournament);

    if (!["free_agents", "both"].includes(tournament.registration_type)) {
      throw Error("this tournament does not accept free agents");
    }

    // The pool only accepts a new entry while registration is open (the same
    // rule the insert trigger enforces for a player joining themselves).
    if (tournament.status !== "RegistrationOpen") {
      throw Error("the free agent pool is locked");
    }

    const [player] = await this.postgres.query<Array<{ steam_id: string }>>(
      `SELECT steam_id::text AS steam_id FROM players WHERE steam_id = $1::bigint`,
      [player_steam_id],
    );

    if (!player) {
      throw Error("player not found");
    }

    const [existing] = await this.postgres.query<Array<{ status: string }>>(
      `SELECT status FROM tournament_free_agents
        WHERE tournament_id = $1::uuid AND player_steam_id = $2::bigint`,
      [tournament_id, player_steam_id],
    );

    if (existing && existing.status !== "withdrawn") {
      throw Error(
        existing.status === "drafted"
          ? "this player has already been drafted onto a team"
          : "this player is already in the free agent pool",
      );
    }

    await this.postgres.query(
      `INSERT INTO tournament_free_agents (tournament_id, player_steam_id)
       VALUES ($1::uuid, $2::bigint)
       ON CONFLICT (tournament_id, player_steam_id)
       DO UPDATE SET status = 'registered', tournament_team_id = NULL
                WHERE tournament_free_agents.status = 'withdrawn'`,
      [tournament_id, player_steam_id],
    );

    this.logger.log(
      `[${tournament_id}] ${data.user.steam_id} added ${player_steam_id} to the free agent pool`,
    );

    return { success: true };
  }

  @HasuraAction()
  public async removeTournamentFreeAgent(data: {
    user: User;
    tournament_id: string;
    player_steam_id: string;
  }) {
    const { tournament_id } = data;
    const player_steam_id = String(data.player_steam_id);
    const tournament = await this.getTournamentAccess(tournament_id, data.user);

    this.requireOrganizer(tournament);

    if (
      !TournamentRegistrationController.FREE_AGENT_POOL_EDITABLE.includes(
        tournament.status,
      )
    ) {
      throw Error("the free agent pool is locked");
    }

    const removed = await this.postgres.query<Array<{ id: string }>>(
      `DELETE FROM tournament_free_agents
        WHERE tournament_id = $1::uuid
          AND player_steam_id = $2::bigint
          AND status IN ('registered', 'waitlisted')
      RETURNING id::text AS id`,
      [tournament_id, player_steam_id],
    );

    if (removed.length === 0) {
      throw Error(
        "this player is not in the free agent pool, or has already been drafted onto a team",
      );
    }

    this.logger.log(
      `[${tournament_id}] ${data.user.steam_id} removed ${player_steam_id} from the free agent pool`,
    );

    return { success: true };
  }

  // Chooses the active players of a tournament match lineup. The rules (exactly
  // the starting size, only the tournament roster, the captain stays, only
  // before the match starts) and who may choose (the team's captain, owner or
  // Admin, and the tournament's organizers and site administrators) live in
  // set_match_starting_lineup, so a direct database write cannot bypass them.
  @HasuraAction()
  public async setMatchStartingLineup(data: {
    user: User;
    match_id: string;
    match_lineup_id: string;
    steam_ids: Array<string>;
  }) {
    await this.terms.assertAccepted(data.user.steam_id);

    await this.postgres.query(
      `SELECT set_match_starting_lineup(
         $1::uuid, $2::uuid, $3::bigint[], $4::json
       )`,
      [
        data.match_id,
        data.match_lineup_id,
        (data.steam_ids ?? []).map((steamId) => String(steamId)),
        this.hasuraSession(data.user),
      ],
    );

    return { success: true };
  }

  private requireRegistrationUnlocked(tournament: TournamentAccess) {
    if (!tournament.invite_only) {
      return;
    }

    if (tournament.is_organizer || tournament.unlocked) {
      return;
    }

    throw Error("this tournament is invite only");
  }

  @HasuraAction()
  public async createTournamentInviteCode(data: {
    user: User;
    tournament_id: string;
    expires_in_minutes?: number | null;
    max_uses?: number | null;
  }) {
    const { tournament_id, expires_in_minutes, max_uses } = data;
    const tournament = await this.getTournamentAccess(tournament_id, data.user);

    this.requireOrganizer(tournament);

    if (expires_in_minutes != null && (!Number.isInteger(expires_in_minutes) || expires_in_minutes <= 0 || expires_in_minutes > 525600)) {
      throw Error("an expiry has to be in the future");
    }

    if (max_uses != null && (!Number.isInteger(max_uses) || max_uses <= 0 || max_uses > 100000)) {
      throw Error("a use limit has to be at least one");
    }

    // The code itself comes from the column default: generating it in SQL keeps
    // one generator for every public link on the platform, and keeps the API
    // out of the business of seeding randomness.
    const [code] = await this.postgres.query<
      Array<{ id: string; code: string }>
    >(
      `INSERT INTO tournament_invite_codes
         (tournament_id, created_by_player_steam_id, expires_at, max_uses)
       VALUES ($1::uuid, $2::bigint,
               CASE WHEN $3::int IS NULL THEN NULL
                    ELSE now() + ($3::int * interval '1 minute') END,
               $4::int)
       RETURNING id::text AS id, code`,
      [
        tournament_id,
        data.user.steam_id,
        expires_in_minutes ?? null,
        max_uses ?? null,
      ],
    );

    return { id: code.id, code: code.code };
  }

  @HasuraAction()
  public async revokeTournamentInviteCode(data: {
    user: User;
    invite_code_id: string;
  }) {
    const { invite_code_id } = data;

    const [code] = await this.postgres.query<Array<{ tournament_id: string }>>(
      `SELECT tournament_id::text AS tournament_id
         FROM tournament_invite_codes
        WHERE id = $1::uuid`,
      [invite_code_id],
    );

    if (!code) {
      throw Error("invite link not found");
    }

    const tournament = await this.getTournamentAccess(
      code.tournament_id,
      data.user,
    );

    this.requireOrganizer(tournament);

    // Stamped rather than deleted: the uses cascade off the code, and revoking
    // a link must not erase the record of who already came in through it.
    await this.postgres.query(
      `UPDATE tournament_invite_codes
          SET revoked_at = now()
        WHERE id = $1::uuid AND revoked_at IS NULL`,
      [invite_code_id],
    );

    return { success: true };
  }

  // An invite code is a bearer credential and redemption takes an arbitrary
  // tournament id, so every logged-in player can grind codes against every
  // tournament.
  public static readonly REDEEM_ATTEMPTS_PER_MINUTE = 5;

  // Every refusal a player can be handed here is thrown as a code rather than a
  // sentence: an action's error reaches the client as `message` and nothing
  // else, so the only way the reason survives in a form the browser can
  // translate is to BE the message. The web side maps each one onto
  // tournament.invite_accept.errors.*; anything unrecognised there falls back to
  // showing the message verbatim, which is why refusals from outside this
  // contract stay prose.
  @HasuraAction()
  public async redeemTournamentInviteCode(data: {
    user: User;
    tournament_id: string;
    code: string;
  }) {
    const { tournament_id, code } = data;

    await this.assertInviteRateLimit({
      key: "tournament-invite-code",
      steamId: data.user.steam_id,
      limit: TournamentRegistrationController.REDEEM_ATTEMPTS_PER_MINUTE,
      message: "invite_rate_limited",
    });

    const tournament = await this.getTournamentAccess(tournament_id, data.user);

    if (!["Setup", "RegistrationOpen"].includes(tournament.status)) {
      throw Error("invite_registration_closed");
    }

    await this.pruneInviteCodes(tournament_id);

    // Lock the tournament and code before reading use rows. This also makes
    // simultaneous redemption by the SAME player idempotent: a statement CTE
    // can otherwise spend two uses while only one audit insert wins its key.
    await this.postgres.transaction(async client => {
      const { rows: [current] } = await client.query("SELECT status FROM tournaments WHERE id=$1::uuid FOR UPDATE", [tournament_id]);
      if (!current || !["Setup", "RegistrationOpen"].includes(current.status)) throw Error("invite_registration_closed");
      const { rows: [link] } = await client.query(
        "SELECT *, expires_at IS NOT NULL AND expires_at <= now() AS expired FROM tournament_invite_codes WHERE tournament_id=$1::uuid AND upper(btrim(code))=upper(btrim($2::text)) FOR UPDATE",
        [tournament_id, code ?? ""],
      );
      if (!link) throw Error("invite_not_found");
      if (link.revoked_at) throw Error("invite_revoked");
      if (link.expired) throw Error("invite_expired");
      const { rows: uses } = await client.query("SELECT 1 FROM tournament_invite_code_uses WHERE invite_code_id=$1::uuid AND player_steam_id=$2::bigint", [link.id, data.user.steam_id]);
      if (!uses.length) {
        if (link.max_uses !== null && link.uses >= link.max_uses) throw Error("invite_used_up");
        await client.query("INSERT INTO tournament_invite_code_uses(invite_code_id,player_steam_id) VALUES($1::uuid,$2::bigint)", [link.id, data.user.steam_id]);
        await client.query("UPDATE tournament_invite_codes SET uses=uses+1 WHERE id=$1::uuid", [link.id]);
      }
      await client.query("INSERT INTO tournament_registration_unlocks(tournament_id,player_steam_id) VALUES($1::uuid,$2::bigint) ON CONFLICT DO NOTHING", [tournament_id,data.user.steam_id]);
    });
    return { success: true };
  }

  // Lazily, on the path that already has this tournament's codes in hand,
  // rather than on a cron. Only codes nobody ever spent: a code with uses on it
  // is the record of who came in through it, and the uses cascade off it. The
  // grace period is what keeps a link that has only just lapsed answering "this
  // expired" instead of "no such link".
  private async pruneInviteCodes(tournamentId: string): Promise<void> {
    await this.postgres.query(
      `DELETE FROM tournament_invite_codes c
        WHERE c.tournament_id = $1::uuid
          AND c.uses = 0
          AND (c.expires_at <= now() - interval '1 day'
               OR c.revoked_at <= now() - interval '1 day')`,
      [tournamentId],
    );
  }

}
