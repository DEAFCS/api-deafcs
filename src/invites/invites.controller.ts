// Tournament registration invite flow adapted from 5Stack API c23d0808; MIT (c) 2025 5Stack.gg.
import { NotificationsService } from "../notifications/notifications.service";
import { e_notification_types_enum } from "../../generated";
import { PostgresService } from "../postgres/postgres.service";
import { Controller } from "@nestjs/common";
import { HasuraService } from "../hasura/hasura.service";
import { HasuraAction, HasuraEvent } from "../hasura/hasura.controller";
import { User } from "../auth/types/User";
import { TermsService } from "../terms/terms.service";

@Controller("invites")
export class InvitesController {
  constructor(
    private readonly hasura: HasuraService,
    private readonly terms: TermsService,
    private readonly postgres: PostgresService,
    private readonly notifications: NotificationsService,
  ) {}

  @HasuraAction()
  public async acceptInvite(data: {
    user: User;
    invite_id: string;
    type: string;
  }) {
    const { invite_id, user, type } = data;

    await this.terms.assertAccepted(user.steam_id);

    if (type === "tournament_registration") return this.resolveTournamentInvite(invite_id, user, true);

    if (type === "team") {
      return await this.acceptTeamInvite(invite_id, user);
    }

    return await this.acceptTournamentTeamInvite(invite_id, user);
  }

  @HasuraEvent()
  public async tournament_invite_events(data: { op: string; new: { id: string } }) {
    if (data.op !== "INSERT") return;
    const [invite] = await this.postgres.query<Array<{ tournament_id: string; name: string; steam_id: string | null; team_id: string | null }>>(
      "SELECT i.tournament_id, t.name, i.steam_id, i.team_id FROM tournament_invites i JOIN tournaments t ON t.id = i.tournament_id WHERE i.id = $1::uuid", [data.new.id],
    );
    if (!invite) return;
    const recipients = invite.team_id ? await this.postgres.query<Array<{ steam_id: string }>>(
      "SELECT steam_id FROM players WHERE public.player_may_register_team($1::uuid, steam_id)", [invite.team_id],
    ) : [{ steam_id: invite.steam_id! }];
    await this.notifications.notifyPlayers("TournamentInvite" as e_notification_types_enum, {
      title: "Tournament Invite", message: 'You have been invited to register for <a href="/tournaments/' + invite.tournament_id + '"><b>' + NotificationsService.escapeHtml(invite.name) + '</b></a>. Accept the invitation in Notifications.', entity_id: data.new.id, role: "user", steamIds: recipients.map(p => String(p.steam_id)),
    });
  }

  // An addressed invite only grants entry; all roster/free-agent eligibility
  // checks still run when the recipient registers. Resolve atomically.
  private async resolveTournamentInvite(inviteId: string, user: User, accept: boolean) {
    return this.postgres.transaction(async (client) => {
      const { rows: [invite] } = await client.query(
        "SELECT i.*, t.status, t.registration_version FROM tournament_invites i JOIN tournaments t ON t.id = i.tournament_id WHERE i.id = $1::uuid AND (i.steam_id = $2::bigint OR public.player_may_register_team(i.team_id, $2::bigint)) FOR UPDATE OF i, t",
        [inviteId, user.steam_id],
      );
      if (!invite) throw new Error("Tournament invite not found or not addressed to you");
      if (accept) {
        if (invite.registration_version !== 2 || !['Setup', 'RegistrationOpen'].includes(invite.status)) throw new Error("Tournament registration is closed");
        await client.query(
          "INSERT INTO tournament_registration_unlocks (tournament_id, player_steam_id, team_id) VALUES ($1::uuid, $2::bigint, $3::uuid) ON CONFLICT DO NOTHING",
          [invite.tournament_id, invite.team_id ? null : user.steam_id, invite.team_id],
        );
      }
      await client.query("DELETE FROM tournament_invites WHERE id = $1::uuid", [inviteId]);
      return { success: true };
    });
  }

  private async acceptTeamInvite(invite_id: string, user: User) {
    const { team_invites_by_pk } = await this.hasura.query({
      team_invites_by_pk: {
        __args: {
          id: invite_id,
        },
        team_id: true,
        steam_id: true,
      },
    });

    if (!team_invites_by_pk) {
      throw Error("unable to find team invite");
    }

    if (team_invites_by_pk.steam_id !== user.steam_id) {
      return {
        success: false,
      };
    }

    await this.hasura.mutation({
      insert_team_roster_one: {
        __args: {
          object: {
            role: "Member",
            team_id: team_invites_by_pk.team_id,
            player_steam_id: user.steam_id,
          },
        },
        __typename: true,
      },
    });

    await this.hasura.mutation({
      delete_team_invites_by_pk: {
        __args: {
          id: invite_id,
        },
        __typename: true,
      },
    });

    return {
      success: true,
    };
  }

  private async acceptTournamentTeamInvite(invite_id: string, user: User) {
    const { tournament_team_invites_by_pk } = await this.hasura.query({
      tournament_team_invites_by_pk: {
        __args: {
          id: invite_id,
        },
        steam_id: true,
        tournament_team_id: true,
        team: {
          tournament_id: true,
        },
      },
    });

    if (!tournament_team_invites_by_pk) {
      throw Error("unable to find team invite");
    }

    if (tournament_team_invites_by_pk.steam_id !== user.steam_id) {
      return {
        success: false,
      };
    }

    // Run this as the accepting player's own session (not the blanket
    // admin-secret client) so the normal tournament_team_roster insert
    // permission -- including its target_meets_min_role check -- actually
    // runs. Accepting an invite you're not eligible for must fail the same
    // way a captain adding you directly would. "role" is deliberately left
    // out of the object: it isn't in the `user` role's permitted insert
    // columns (a regular session can't set it directly), so this leans on
    // the column default ('Member') the same way a captain's own direct add
    // already does.
    await this.hasura.mutation(
      {
        insert_tournament_team_roster_one: {
          __args: {
            object: {
              tournament_id: tournament_team_invites_by_pk.team.tournament_id,
              tournament_team_id:
                tournament_team_invites_by_pk.tournament_team_id,
              player_steam_id: user.steam_id,
            },
            on_conflict: {
              constraint: "tournament_roster_pkey",
              update_columns: ["role"],
            },
          },
          __typename: true,
        },
      },
      user.steam_id,
    );

    await this.hasura.mutation({
      delete_tournament_team_invites_by_pk: {
        __args: {
          id: invite_id,
        },
        __typename: true,
      },
    });

    return {
      success: true,
    };
  }

  @HasuraAction()
  public async denyInvite(data: {
    user: User;
    invite_id: string;
    type: string;
  }) {
    const { invite_id, user, type } = data;

    if (type === "tournament_registration") return this.resolveTournamentInvite(invite_id, user, false);

    if (type === "team") {
      return this.denyTeamInvite(invite_id, user);
    }

    return this.denyTournamentTeamInvite(invite_id, user);
  }

  public async denyTeamInvite(invite_id: string, user: User) {
    const { team_invites_by_pk } = await this.hasura.query({
      team_invites_by_pk: {
        __args: {
          id: invite_id,
        },
        team_id: true,
        steam_id: true,
      },
    });

    if (!team_invites_by_pk) {
      throw Error("unable to find team invite");
    }

    if (team_invites_by_pk.steam_id !== user.steam_id) {
      return {
        success: false,
      };
    }

    await this.hasura.mutation({
      delete_team_invites_by_pk: {
        __args: {
          id: invite_id,
        },
        __typename: true,
      },
    });

    return {
      success: true,
    };
  }

  public async denyTournamentTeamInvite(invite_id: string, user: User) {
    const { tournament_team_invites_by_pk } = await this.hasura.query({
      tournament_team_invites_by_pk: {
        __args: {
          id: invite_id,
        },
        steam_id: true,
        tournament_team_id: true,
        team: {
          tournament_id: true,
        },
      },
    });

    if (!tournament_team_invites_by_pk) {
      throw Error("unable to find team invite");
    }

    if (tournament_team_invites_by_pk.steam_id !== user.steam_id) {
      return {
        success: false,
      };
    }

    await this.hasura.mutation({
      delete_tournament_team_invites_by_pk: {
        __args: {
          id: invite_id,
        },
        __typename: true,
      },
    });

    return {
      success: true,
    };
  }
}
