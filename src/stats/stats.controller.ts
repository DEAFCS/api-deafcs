import { BadRequestException, Controller, Get, Header, Query } from "@nestjs/common";
import {
  WEEKLY_RECORD_MODES,
  WeeklyRecordMode,
  WeeklyRecordsService,
} from "./weekly-records.service";

// Public, read-only community statistics.
//
//   GET /stats/weekly-records?mode=Competitive
//       Last 7 days Top 5 records (homepage "Last 7 Days"). Shared Redis
//       cache, fresh for 5 minutes. `available: false` means no safe result
//       exists yet and another request is computing it: the homepage shows
//       its loading/unavailable state instead of recomputing.
@Controller("stats")
export class StatsController {
  constructor(private readonly weeklyRecords: WeeklyRecordsService) {}

  @Get("weekly-records")
  // Public data; browsers and shared caches may keep it a minute.
  @Header("Cache-Control", "public, max-age=60")
  public async getWeeklyRecords(@Query("mode") mode?: string) {
    const value = (mode ?? "Competitive") as WeeklyRecordMode;
    if (!(WEEKLY_RECORD_MODES as readonly string[]).includes(value)) {
      throw new BadRequestException({ error: "unsupported_mode" });
    }
    return this.weeklyRecords.get(value);
  }
}
