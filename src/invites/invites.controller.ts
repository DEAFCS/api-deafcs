import { Controller } from "@nestjs/common";
import { HasuraService } from "../hasura/hasura.service";
import { HasuraAction } from "../hasura/hasura.controller";
import { User } from "../auth/types/User";
import { TermsService } from "../terms/terms.service";

@Controller("invites")
export class InvitesController {
  constructor(
    private readonly hasura: HasuraService,
    private readonly terms: TermsService,
  ) {}

  @HasuraAction()
  public async acceptInvite(data: {
    user: User;
    invite_id: string;
    type: string;
  }) {
    const { invite_id, user, type } = data;

    await this.terms.assertAccepted(user.steam_id);

    if (type === "team") {
      return await this.acceptTeamInvite(invite_id, user);
    }

    return await this.acceptTournamentTeamInvite(invite_id, user);
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
