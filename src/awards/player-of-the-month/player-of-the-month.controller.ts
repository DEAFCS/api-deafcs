import { Controller, ForbiddenException } from "@nestjs/common";
import { User } from "../../auth/types/User";
import { HasuraAction } from "../../hasura/hasura.controller";
import { PlayerOfTheMonthService } from "./player-of-the-month.service";

// Player of the Month staff review (Hasura actions; administrators only,
// checked here for every call whatever the Hasura action permissions say).
//
//   playerOfTheMonthReview(month)                 read the stored review
//   calculatePlayerOfTheMonth(month)              (re)calculate candidates
//   approvePlayerOfTheMonth(month, player, note)  award the month
//   rejectPlayerOfTheMonth(month, note)           no winner this month
@Controller()
export class PlayerOfTheMonthController {
  constructor(private readonly service: PlayerOfTheMonthService) {}

  private requireAdministrator(user?: User): User {
    if (!user?.steam_id || user.role !== "administrator") {
      throw new ForbiddenException("Only administrators can review Player of the Month");
    }
    return user;
  }

  @HasuraAction()
  public async playerOfTheMonthReview(data: { month: string; user?: User }) {
    this.requireAdministrator(data.user);
    this.service.assertReviewableMonth(data.month);
    return this.service.getReview(data.month);
  }

  @HasuraAction()
  public async calculatePlayerOfTheMonth(data: { month: string; user?: User }) {
    const user = this.requireAdministrator(data.user);
    return this.service.calculate(data.month, String(user.steam_id));
  }

  @HasuraAction()
  public async approvePlayerOfTheMonth(data: {
    month: string;
    player_steam_id: string;
    note?: string | null;
    user?: User;
  }) {
    const user = this.requireAdministrator(data.user);
    return this.service.approve(
      data.month,
      String(data.player_steam_id ?? ""),
      data.note?.trim() || null,
      String(user.steam_id),
    );
  }

  @HasuraAction()
  public async rejectPlayerOfTheMonth(data: { month: string; note: string; user?: User }) {
    const user = this.requireAdministrator(data.user);
    return this.service.reject(data.month, data.note, String(user.steam_id));
  }
}
