import { Controller } from "@nestjs/common";
import { HasuraAction } from "src/hasura/hasura.controller";
import { User } from "src/auth/types/User";
import { isRoleAbove } from "src/utilities/isRoleAbove";
import { MatchAssistantService } from "../match-assistant/match-assistant.service";
import { MatchRecoveryService } from "./match-recovery.service";

@Controller("match-recovery")
export class MatchRecoveryController {
  constructor(
    private readonly matchAssistant: MatchAssistantService,
    private readonly recovery: MatchRecoveryService,
  ) {}

  @HasuraAction()
  public async getMatchRestoreRounds(data: { match_id: string; user: User }) {
    await this.requireOrganizer(data.match_id, data.user);

    return await this.recovery.getRestoreRounds(data.match_id, data.user);
  }

  @HasuraAction()
  public async restoreMatchRound(data: {
    match_id: string;
    round: number;
    user: User;
  }) {
    await this.requireOrganizer(data.match_id, data.user);

    return await this.recovery.restoreRound(
      data.match_id,
      data.round,
      data.user,
    );
  }

  @HasuraAction()
  public async restartMatchMap(data: { match_id: string; user: User }) {
    await this.requireOrganizer(data.match_id, data.user);

    return await this.recovery.restartMatchMap(data.match_id, data.user);
  }

  @HasuraAction()
  public async rewindMapVeto(data: {
    match_id: string;
    step: number;
    expected_picks?: number;
    user: User;
  }) {
    await this.requireOrganizer(data.match_id, data.user);

    return await this.recovery.rewindMapVeto(
      data.match_id,
      data.step,
      data.expected_picks,
      data.user,
    );
  }

  // DEAFCS: Pause and Resume for organizers without the RCON console.
  @HasuraAction()
  public async setMatchPaused(data: {
    match_id: string;
    paused: boolean;
    user: User;
  }) {
    await this.requireOrganizer(data.match_id, data.user);

    return await this.recovery.setMatchPaused(
      data.match_id,
      data.paused === true,
      data.user,
    );
  }

  // DEAFCS: administrators only for now (the metadata action too); upstream
  // lets every match organizer restart. Organizers keep Restore Round,
  // Restart Map and Pause/Resume.
  @HasuraAction()
  public async restartMatch(data: { match_id: string; user: User }) {
    if (!isRoleAbove(data.user?.role, "administrator")) {
      throw Error("only administrators can restart a match");
    }

    return await this.recovery.restartMatch(data.match_id, data.user);
  }

  private async requireOrganizer(matchId: string, user: User) {
    if (!(await this.matchAssistant.isOrganizer(matchId, user))) {
      throw Error("you are not a match organizer");
    }
  }
}
