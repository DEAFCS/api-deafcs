import { Controller } from "@nestjs/common";
import { HasuraAction } from "src/hasura/hasura.controller";
import { User } from "src/auth/types/User";
import { PostgresService } from "src/postgres/postgres.service";
import { MatchAssistantService } from "src/matches/match-assistant/match-assistant.service";
import { isPreMatchRecoveryStaff } from "src/matches/match-recovery/pre-match-recovery-staff";
import { CaptainPickService } from "./captain-pick.service";

// DEAFCS: Reset Captain Pick, the staff recovery for a Captain Pick match
// (same rule as Reset Veto: administrators and match organizers on every
// match, tournament organizers on their own tournaments' matches, also while
// playing; never a match's owner or a moderator).
@Controller("captain-pick-recovery")
export class CaptainPickRecoveryController {
  constructor(
    private readonly matchAssistant: MatchAssistantService,
    private readonly postgres: PostgresService,
    private readonly captainPick: CaptainPickService,
  ) {}

  @HasuraAction()
  public async resetCaptainPick(data: {
    match_id: string;
    expected_picks?: number;
    user: User;
  }) {
    if (!(await this.matchAssistant.isOrganizer(data.match_id, data.user))) {
      throw Error("you are not a match organizer");
    }

    if (
      !(await isPreMatchRecoveryStaff(this.postgres, data.match_id, data.user))
    ) {
      throw Error("only staff can reset the Captain Pick");
    }

    // The draft's own phase is checked again inside the reset; this keeps a
    // match that left PickingPlayers (canceled, seated, Live) out up front.
    const [match] = await this.postgres.query<Array<{ status: string }>>(
      "SELECT status FROM matches WHERE id = $1",
      [data.match_id],
    );
    if (match?.status !== "PickingPlayers") {
      throw Error("the Captain Pick can only be reset while the captains pick");
    }

    await this.captainPick.resetDraft(
      data.match_id,
      data.user,
      data.expected_picks ?? undefined,
    );

    return { success: true };
  }
}
