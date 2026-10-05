import { Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { TournamentsModule } from "./tournaments.module";
import { TournamentsController } from "./tournaments.controller";
import { TournamentRegistrationController } from "./tournament-registration.controller";
import { TournamentRegistrationService } from "./tournament-registration.service";

describe("TournamentsModule registration dependency wiring", () => {
  it("resolves both real controllers through one shared registration provider", async () => {
    // Replace only infrastructure modules; preserve the real tournament module,
    // controller constructors and registration service/provider declarations.
    const controllers = [TournamentsController, TournamentRegistrationController];
    const dependencies = [...new Set<any>(controllers.flatMap(controller =>
      Reflect.getMetadata("design:paramtypes", controller) ?? [],
    ))].filter(token => !controllers.includes(token) && token !== TournamentRegistrationService);
    @Module({
      providers: dependencies.map(provide => ({ provide, useValue: { getConnection: () => ({}) } })),
      exports: dependencies,
    })
    class Infrastructure {}
    const builder = Test.createTestingModule({ imports: [TournamentsModule] });
    for (const dependency of Reflect.getMetadata("imports", TournamentsModule)) {
      builder.overrideModule(dependency).useModule(Infrastructure);
    }
    const module = await builder.compile();
    try {
      const service = module.get(TournamentRegistrationService);
      expect(service).toBeInstanceOf(TournamentRegistrationService);
      for (const controller of controllers) {
        expect((module.get(controller) as any).registration).toBe(service);
      }
    } finally {
      await module.close();
    }
  });
});
