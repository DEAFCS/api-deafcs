import { Module } from "@nestjs/common";
import { HasuraModule } from "../hasura/hasura.module";
import { PostgresModule } from "../postgres/postgres.module";
import { loggerFactory } from "../utilities/LoggerFactory";
import { TournamentTeamGenerationService } from "./tournament-team-generation.service";

// Small, standalone module (rather than folding this into the larger
// TournamentsModule) so ProcessTournamentAttendance in MatchesModule can
// import just the team-generation logic it needs without pulling in
// TournamentsModule's unrelated dependencies (demos, clips, Discord voice).
@Module({
  imports: [HasuraModule, PostgresModule],
  providers: [TournamentTeamGenerationService, loggerFactory()],
  exports: [TournamentTeamGenerationService],
})
export class TournamentTeamGenerationModule {}
