import { VerificationApplicationsController } from "../src/verification-applications/verification-applications.controller";
import { Fixtures } from "./utils/fixtures";
import { bootContainerAndMigrate, SqlTestDb } from "./utils/sql-test-db";

describe("verification approval role safety", () => {
  let db: SqlTestDb;
  let fx: Fixtures;
  let controller: VerificationApplicationsController;
  let notifications: { notifyPlayers: jest.Mock; send: jest.Mock };

  beforeAll(async () => {
    db = await bootContainerAndMigrate("VerificationApprovalSecurityTest");
    fx = new Fixtures(db.postgres, 76561199992000000n);
    notifications = {
      notifyPlayers: jest.fn().mockResolvedValue(undefined),
      send: jest.fn().mockResolvedValue(undefined),
    };
    controller = new VerificationApplicationsController(
      {} as any,
      db.postgres,
      notifications as any,
      { get: () => ({ webDomain: "https://example.test" }) } as any,
    );
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  async function applicationFor(playerSteamId: string): Promise<string> {
    const [application] = await db.postgres.query<Array<{ id: string }>>(
      `INSERT INTO verification_applications
         (player_steam_id, is_deaf, country, found_via,
          account_declaration_accepted_at)
       VALUES ($1, 'yes', 'DK', 'community', now()) RETURNING id`,
      [playerSteamId],
    );
    return application.id;
  }

  it("allows a Moderator to approve an ordinary user", async () => {
    const applicant = await fx.player();
    const applicationId = await applicationFor(applicant);

    await controller.approveVerificationApplication({
      application_id: applicationId,
      user: {
        steam_id: await fx.player(),
        role: "moderator",
        name: "Moderator",
      } as any,
    });

    const [player] = await db.postgres.query<Array<{ role: string }>>(
      "SELECT role FROM players WHERE steam_id = $1",
      [applicant],
    );
    expect(player.role).toBe("verified_user");
  });

  it("never demotes an applicant who already has an elevated role", async () => {
    const applicant = await fx.player();
    await db.postgres.query(
      "UPDATE players SET role = 'tournament_organizer' WHERE steam_id = $1",
      [applicant],
    );
    const applicationId = await applicationFor(applicant);

    await controller.approveVerificationApplication({
      application_id: applicationId,
      user: {
        steam_id: await fx.player(),
        role: "moderator",
        name: "Moderator",
      } as any,
    });

    const [player] = await db.postgres.query<Array<{ role: string }>>(
      "SELECT role FROM players WHERE steam_id = $1",
      [applicant],
    );
    expect(player.role).toBe("tournament_organizer");
  });

  it("rejects approval by a non-moderator", async () => {
    const applicant = await fx.player();
    const applicationId = await applicationFor(applicant);

    await expect(
      controller.approveVerificationApplication({
        application_id: applicationId,
        user: {
          steam_id: await fx.player(),
          role: "verified_user",
          name: "Verified User",
        } as any,
      }),
    ).rejects.toThrow(/Moderator access required/i);

    const [application] = await db.postgres.query<Array<{ status: string }>>(
      "SELECT status FROM verification_applications WHERE id = $1",
      [applicationId],
    );
    expect(application.status).toBe("pending");
  });
});
