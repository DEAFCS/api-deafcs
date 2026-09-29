import { Injectable } from "@nestjs/common";
import { HasuraService } from "src/hasura/hasura.service";
import {
  CAPTAIN_PICK_ENABLED_SETTING,
  CAPTAIN_PICK_SECONDS_SETTING,
  CaptainPickSettings,
  parseCaptainPickSettings,
} from "./captain-pick-settings";

@Injectable()
export class CaptainPickSettingsService {
  constructor(private readonly hasura: HasuraService) {}

  public async getSettings(): Promise<CaptainPickSettings> {
    const { settings } = await this.hasura.query({
      settings: {
        __args: {
          where: {
            name: {
              _in: [CAPTAIN_PICK_ENABLED_SETTING, CAPTAIN_PICK_SECONDS_SETTING],
            },
          },
        },
        name: true,
        value: true,
      },
    });

    return parseCaptainPickSettings(settings ?? []);
  }
}
