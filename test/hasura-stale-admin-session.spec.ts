import http from "http";
import path from "path";
import WebSocket from "ws";
import { GenericContainer, StartedTestContainer, Wait } from "testcontainers";
import { Fixtures } from "./utils/fixtures";
import { bootContainerAndMigrate, SqlTestDb } from "./utils/sql-test-db";

// DEAFCS Security Batch 3. Hasura authorizes a GraphQL WebSocket once, when it
// opens, through the API's auth hook (GET /hasura). An administrator demoted
// while a tab was open kept a session that said "administrator", and the
// players trigger trusted that session role, so they could promote themselves
// back over the open socket. The trigger now reads the caller's current role.
describe("stale Hasura administrator sessions", () => {
  let db: SqlTestDb;
  let hasura: StartedTestContainer;
  let hook: http.Server;
  let endpoint: string;
  let fx: Fixtures;
  const adminSecret = "stale-admin-session-test";

  // What the test auth hook answers, per test session id.
  const hookSessions = new Map<string, Record<string, string>>();
  let hookCacheControl: string | undefined;
  let hookExpiresInMs: number | undefined;
  let hookCalls = 0;

  beforeAll(async () => {
    db = await bootContainerAndMigrate("StaleAdminSessionTest");
    fx = new Fixtures(db.postgres, 76561199992000000n);

    hook = http.createServer((request, response) => {
      hookCalls++;
      const session = hookSessions.get(
        String(request.headers["x-test-session"] ?? ""),
      ) ?? { "x-hasura-role": "guest", "x-hasura-user-id": "0" };
      response.setHeader("Content-Type", "application/json");
      if (hookCacheControl) {
        response.setHeader("Cache-Control", hookCacheControl);
      }
      if (hookExpiresInMs) {
        response.setHeader(
          "Expires",
          new Date(Date.now() + hookExpiresInMs).toUTCString(),
        );
      }
      response.end(JSON.stringify(session));
    });
    await new Promise<void>((resolve) => hook.listen(0, "0.0.0.0", resolve));
    const hookPort = (hook.address() as { port: number }).port;

    const databaseUrl =
      `postgres://${db.container!.getUsername()}:${db.container!.getPassword()}` +
      `@host.docker.internal:${db.container!.getPort()}/${db.container!.getDatabase()}`;

    // The production engine version.
    hasura = await new GenericContainer(
      "hasura/graphql-engine:v2.49.4-ce.cli-migrations-v3",
    )
      .withEnvironment({
        HASURA_GRAPHQL_DATABASE_URL: databaseUrl,
        HASURA_GRAPHQL_ADMIN_SECRET: adminSecret,
        HASURA_GRAPHQL_AUTH_HOOK: `http://host.docker.internal:${hookPort}/hasura`,
        HASURA_GRAPHQL_ACTIONS_HOOK: "http://host.docker.internal:3000",
        HASURA_GRAPHQL_EVENT_HOOK: "http://host.docker.internal:3000/events",
        HASURA_GRAPHQL_STRINGIFY_NUMERIC_TYPES: "true",
      })
      .withBindMounts([
        {
          source: path.resolve("./hasura/metadata"),
          target: "/hasura-metadata",
          mode: "ro",
        },
      ])
      .withExposedPorts(8080)
      .withWaitStrategy(Wait.forHttp("/healthz", 8080).forStatusCode(200))
      .start();

    endpoint = `${hasura.getHost()}:${hasura.getMappedPort(8080)}`;
  }, 600_000);

  afterAll(async () => {
    await hasura?.stop();
    await new Promise((resolve) => hook?.close(resolve));
    await db?.stop();
  });

  afterEach(() => {
    hookSessions.clear();
    hookCacheControl = undefined;
    hookExpiresInMs = undefined;
  });

  async function setRole(steamId: string, role: string) {
    await db.postgres.query(
      "UPDATE players SET role = $2 WHERE steam_id = $1",
      [steamId, role],
    );
  }

  async function roleOf(steamId: string): Promise<string> {
    const [row] = await db.postgres.query<Array<{ role: string }>>(
      "SELECT role FROM players WHERE steam_id = $1",
      [steamId],
    );
    return row.role;
  }

  // A request carrying a session, the way Hasura runs it for an open socket.
  async function asSession(
    role: string,
    steamId: string | undefined,
    query: string,
  ): Promise<{ data?: any; errors?: Array<{ message: string }> }> {
    const response = await fetch(`http://${endpoint}/v1/graphql`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hasura-admin-secret": adminSecret,
        "x-hasura-role": role,
        ...(steamId ? { "x-hasura-user-id": steamId } : {}),
      },
      body: JSON.stringify({ query }),
    });
    return response.json();
  }

  const setRoleMutation = (target: string, role: string) =>
    `mutation { update_players_by_pk(pk_columns: { steam_id: "${target}" }, _set: { role: ${role} }) { role } }`;

  describe("role changes", () => {
    it("refuses a demoted administrator promoting themselves back", async () => {
      const formerAdmin = await fx.player();
      await setRole(formerAdmin, "user");

      const result = await asSession(
        "administrator",
        formerAdmin,
        setRoleMutation(formerAdmin, "administrator"),
      );

      expect(result.errors?.[0]?.message).toMatch(
        /Only administrators can change player roles/,
      );
      expect(await roleOf(formerAdmin)).toBe("user");
    });

    it("refuses a demoted administrator changing anyone else's role", async () => {
      const formerAdmin = await fx.player();
      const other = await fx.player();
      await setRole(formerAdmin, "moderator");

      for (const role of ["administrator", "verified_user", "user"]) {
        await setRole(other, role === "user" ? "verified_user" : "user");
        const before = await roleOf(other);
        const result = await asSession(
          "administrator",
          formerAdmin,
          setRoleMutation(other, role),
        );
        expect(result.errors).toBeDefined();
        expect(await roleOf(other)).toBe(before);
      }
    });

    it("refuses an administrator session for a player who no longer exists or has no id", async () => {
      const target = await fx.player();

      for (const steamId of [
        undefined,
        "0",
        "not-a-steam-id",
        "76561199992999999",
      ]) {
        const result = await asSession(
          "administrator",
          steamId,
          setRoleMutation(target, "moderator"),
        );
        expect(result.errors).toBeDefined();
      }
      expect(await roleOf(target)).toBe("user");
    });

    it("lets a current administrator grant and remove Verified and staff roles", async () => {
      const admin = await fx.player();
      const target = await fx.player();
      await setRole(admin, "administrator");

      for (const role of [
        "verified_user",
        "user",
        "moderator",
        "administrator",
        "verified_user",
      ]) {
        const result = await asSession(
          "administrator",
          admin,
          setRoleMutation(target, role),
        );
        expect(result.errors).toBeUndefined();
        expect(result.data.update_players_by_pk.role).toBe(role);
      }
    });

    it("lets a current administrator step down", async () => {
      const admin = await fx.player();
      await setRole(admin, "administrator");

      const result = await asSession(
        "administrator",
        admin,
        setRoleMutation(admin, "moderator"),
      );

      expect(result.errors).toBeUndefined();
      expect(await roleOf(admin)).toBe("moderator");
    });

    it("keeps role changes from the API (admin secret) and internal SQL working", async () => {
      const target = await fx.player();

      const response = await fetch(`http://${endpoint}/v1/graphql`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-hasura-admin-secret": adminSecret,
        },
        body: JSON.stringify({
          query: setRoleMutation(target, "verified_user"),
        }),
      });
      const result = await response.json();
      expect(result.errors).toBeUndefined();
      expect(await roleOf(target)).toBe("verified_user");

      // Verification approval runs this from the API without a session.
      await setRole(target, "user");
      expect(await roleOf(target)).toBe("user");
    });

    it("still refuses moderators", async () => {
      const moderator = await fx.player();
      const target = await fx.player();
      await setRole(moderator, "moderator");

      const result = await asSession(
        "moderator",
        moderator,
        setRoleMutation(target, "verified_user"),
      );

      expect(result.errors).toBeDefined();
      expect(await roleOf(target)).toBe("user");
    });
  });

  describe("GraphQL WebSocket sessions", () => {
    type Protocol = "graphql-transport-ws" | "graphql-ws";
    type Socket = {
      protocol: Protocol;
      ws: WebSocket;
      messages: Array<any>;
      closed: Promise<{ code: number; reason: string }>;
    };

    async function openSocket(
      sessionId: string,
      protocol: Protocol = "graphql-transport-ws",
    ): Promise<Socket> {
      const ws = new WebSocket(`ws://${endpoint}/v1/graphql`, [protocol]);
      const messages: Array<any> = [];
      const closed = new Promise<{ code: number; reason: string }>((resolve) =>
        ws.on("close", (code, reason) =>
          resolve({ code, reason: reason.toString() }),
        ),
      );
      ws.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
      await new Promise((resolve) => ws.on("open", resolve));
      ws.send(
        JSON.stringify({
          type: "connection_init",
          payload: { headers: { "x-test-session": sessionId } },
        }),
      );
      await waitFor(() => messages.some((m) => m.type === "connection_ack"));
      return { protocol, ws, messages, closed };
    }

    let opId = 0;
    async function run(socket: Socket, query: string) {
      const id = String(++opId);
      const legacy = socket.protocol === "graphql-ws";
      socket.ws.send(
        JSON.stringify({
          id,
          type: legacy ? "start" : "subscribe",
          payload: { query },
        }),
      );
      await waitFor(() =>
        socket.messages.some(
          (m) => m.id === id && ["next", "data", "error"].includes(m.type),
        ),
      );
      return socket.messages.find((m) => m.id === id);
    }

    async function waitFor(check: () => boolean, ms = 10_000) {
      const until = Date.now() + ms;
      while (!check()) {
        if (Date.now() > until) throw new Error("timed out");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    it("keeps the role the socket opened with (why the trigger re-reads it)", async () => {
      const formerAdmin = await fx.player();
      await setRole(formerAdmin, "administrator");
      hookSessions.set("a", {
        "x-hasura-role": "administrator",
        "x-hasura-user-id": formerAdmin,
      });
      const socket = await openSocket("a");

      // Demoted: the hook would now answer "user", but is not asked again.
      await setRole(formerAdmin, "user");
      hookSessions.set("a", {
        "x-hasura-role": "user",
        "x-hasura-user-id": formerAdmin,
      });
      const callsBefore = hookCalls;
      const promote = await run(
        socket,
        setRoleMutation(formerAdmin, "administrator"),
      );

      expect(hookCalls).toBe(callsBefore);
      expect(JSON.stringify(promote)).toMatch(
        /Only administrators can change player roles/,
      );
      expect(await roleOf(formerAdmin)).toBe("user");
      socket.ws.close();
    });

    // Hasura documents that a hook response with Cache-Control or Expires sets
    // the socket session's lifetime. v2.49.4 CE (production) neither closes
    // the socket nor asks the hook again, on either protocol, so headers cannot
    // end a stale session: the database check above is what holds. If an
    // engine upgrade starts honouring expiry, this fails, and the hook could
    // then send Cache-Control to shorten stale sessions.
    it.each([
      ["graphql-transport-ws", "Cache-Control"],
      ["graphql-transport-ws", "Expires"],
      ["graphql-ws", "Cache-Control"],
      ["graphql-ws", "Expires"],
    ] as Array<[Protocol, string]>)(
      "does not end a %s session when the hook's %s lifetime is over",
      async (protocol, header) => {
        const formerAdmin = await fx.player();
        await setRole(formerAdmin, "administrator");
        if (header === "Cache-Control") hookCacheControl = "max-age=2";
        else hookExpiresInMs = 2000;
        const sessionId = `${protocol}:${header}`;
        hookSessions.set(sessionId, {
          "x-hasura-role": "administrator",
          "x-hasura-user-id": formerAdmin,
        });
        const socket = await openSocket(sessionId, protocol);
        const callsAfterOpen = hookCalls;

        await setRole(formerAdmin, "user");
        hookSessions.set(sessionId, {
          "x-hasura-role": "user",
          "x-hasura-user-id": formerAdmin,
        });
        const state = await Promise.race([
          socket.closed,
          new Promise((resolve) => setTimeout(() => resolve("open"), 6_000)),
        ]);
        expect(state).toBe("open");

        // Still an administrator session: Hasura lets the update reach the
        // trigger, which refuses it.
        const promote = await run(
          socket,
          setRoleMutation(formerAdmin, "administrator"),
        );
        expect(hookCalls).toBe(callsAfterOpen);
        expect(JSON.stringify(promote)).toMatch(
          /Only administrators can change player roles/,
        );
        expect(await roleOf(formerAdmin)).toBe("user");
        socket.ws.close();
      },
      30_000,
    );
  });
});
