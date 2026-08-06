import { Module } from "@nestjs/common";
import { TournamentsController } from "./tournaments.controller";
import { HasuraModule } from "../hasura/hasura.module";
import { DemosModule } from "../demos/demos.module";
import { ClipsModule } from "../matches/clips/clips.module";
import { DiscordTournamentVoiceModule } from "../discord-bot/discord-tournament-voice/discord-tournament-voice.module";
import { PostgresModule } from "../postgres/postgres.module";
import { AwardsModule } from "../awards/awards.module";
import { loggerFactory } from "../utilities/LoggerFactory";

@Module({
  imports: [
    HasuraModule,
    DemosModule,
    ClipsModule,
    DiscordTournamentVoiceModule,
    PostgresModule,
    AwardsModule,
  ],
  controllers: [TournamentsController],
  providers: [loggerFactory()],
})
export class TournamentsModule {}
