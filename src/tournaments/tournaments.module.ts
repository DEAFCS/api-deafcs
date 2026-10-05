import { TournamentRegistrationController } from "./tournament-registration.controller";
import { RedisModule } from "../redis/redis.module";
import { Module } from "@nestjs/common";
import { TournamentsController } from "./tournaments.controller";
import { HasuraModule } from "../hasura/hasura.module";
import { DemosModule } from "../demos/demos.module";
import { ClipsModule } from "../matches/clips/clips.module";
import { DiscordTournamentVoiceModule } from "../discord-bot/discord-tournament-voice/discord-tournament-voice.module";
import { PostgresModule } from "../postgres/postgres.module";
import { AwardsModule } from "../awards/awards.module";
import { loggerFactory } from "../utilities/LoggerFactory";
import { NotificationsModule } from "../notifications/notifications.module";
import { TournamentTeamGenerationModule } from "./tournament-team-generation.module";
import { TermsModule } from "../terms/terms.module";

@Module({
  imports: [
    HasuraModule,
    DemosModule,
    ClipsModule,
    DiscordTournamentVoiceModule,
    PostgresModule,
    TermsModule,
    RedisModule,
    AwardsModule,
    NotificationsModule,
    TournamentTeamGenerationModule,
  ],
  controllers: [TournamentsController, TournamentRegistrationController],
  providers: [loggerFactory()],
})
export class TournamentsModule {}
