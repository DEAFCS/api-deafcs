import { Logger } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { HasuraService } from "../hasura/hasura.service";
import {
  FileManagerController,
  FileUploadAdminGuard,
} from "./file-manager.controller";
import { FileManagerService } from "./file-manager.service";

describe("file upload authorization", () => {
  let app: INestApplication;
  let databaseRole: string | undefined;
  const query = jest.fn();
  const connector = jest.fn();
  const originalFetch = global.fetch;

  beforeAll(async () => {
    query.mockImplementation(async (selection) => {
      if (selection.players_by_pk)
        return { players_by_pk: databaseRole ? { role: databaseRole } : null };
      return { game_server_nodes_by_pk: { node_ip: "127.0.0.1" } };
    });
    const module = await Test.createTestingModule({
      controllers: [FileManagerController],
      providers: [
        FileManagerService,
        FileUploadAdminGuard,
        { provide: HasuraService, useValue: { query } },
        { provide: Logger, useValue: { warn: jest.fn(), error: jest.fn() } },
      ],
    }).compile();
    app = module.createNestApplication();
    // Test-only session injection. The claimed session role deliberately differs
    // from the current database role, which must control authorization.
    app.use((req: any, _res: any, next: () => void) => {
      if (req.headers["x-test-session"])
        req.user = { steam_id: "caller", role: "administrator" };
      next();
    });
    await app.init();
    global.fetch = connector as unknown as typeof fetch;
  });
  afterAll(async () => {
    global.fetch = originalFetch;
    await app.close();
  });
  beforeEach(() => {
    query.mockClear();
    connector.mockReset();
    databaseRole = undefined;
    connector.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    });
  });

  describe.each([
    "/file-manager/upload/node",
    "/file-manager/upload/node/server",
  ])("%s", (path) => {
    it("rejects an anonymous caller spoofing the body administrator ID", async () => {
      await request(app.getHttpServer())
        .post(path)
        .field("userId", "administrator-id")
        .field("filePath", "test.cfg")
        .attach("file", Buffer.from("test"), "test.cfg")
        .expect(403);
      expect(query).not.toHaveBeenCalled();
      expect(connector).not.toHaveBeenCalled();
    });
    it.each([
      "guest",
      "user",
      "verified_user",
      "moderator",
      "match_organizer",
      "tournament_organizer",
      "streamer",
    ])(
      "rejects database role %s even with a claimed administrator session and spoofed body",
      async (role) => {
        databaseRole = role;
        await request(app.getHttpServer())
          .post(path)
          .set("x-test-session", "present")
          .field("userId", "administrator-id")
          .attach("file", Buffer.from("test"), "test.cfg")
          .expect(403);
        expect(query.mock.calls[0][0].players_by_pk.__args.steam_id).toBe(
          "caller",
        );
        expect(
          query.mock.calls.some(
            ([selection]) => selection.game_server_nodes_by_pk,
          ),
        ).toBe(false);
        expect(connector).not.toHaveBeenCalled();
      },
    );
    it("rejects a deleted requester before parsing a missing file", async () => {
      await request(app.getHttpServer())
        .post(path)
        .set("x-test-session", "present")
        .expect(403);
      expect(connector).not.toHaveBeenCalled();
    });
    it("preserves an administrator upload and ignores the supplied body identity", async () => {
      databaseRole = "administrator";
      await request(app.getHttpServer())
        .post(path)
        .set("x-test-session", "present")
        .field("userId", "other-user")
        .field("filePath", "test.cfg")
        .attach("file", Buffer.from("test"), "test.cfg")
        .expect(201, { success: true });
      expect(
        query.mock.calls
          .filter(([selection]) => selection.players_by_pk)
          .every(
            ([selection]) =>
              selection.players_by_pk.__args.steam_id === "caller",
          ),
      ).toBe(true);
      expect(connector).toHaveBeenCalledTimes(1);
      const form = connector.mock.calls[0][1].body as FormData;
      expect(form.get("basePath")).toBe(
        path.endsWith("/server") ? "/servers/server" : "/custom-plugins",
      );
      expect(form.get("filePath")).toBe("test.cfg");
    });
  });
});
