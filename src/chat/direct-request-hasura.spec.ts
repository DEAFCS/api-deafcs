import { Pool } from "pg";
import { readFileSync } from "fs";
import { join } from "path";
const enabled =
  process.env.MESSAGE_REQUESTS_TEST_PORT === "15437" &&
  process.env.MESSAGE_REQUESTS_HASURA_TEST_PORT === "18087" &&
  !!process.env.MESSAGE_REQUESTS_HASURA_TEST_SECRET;
const localDescribe = enabled ? describe : describe.skip;
localDescribe("Message Requests permissions on disposable Hasura", () => {
  let pool: Pool;
  const endpoint = "http://127.0.0.1:18087";
  const roles = [
    "user",
    "verified_user",
    "streamer",
    "moderator",
    "match_organizer",
    "tournament_organizer",
    "administrator",
  ];
  async function api(path: string, body: any, role?: string) {
    const response = await fetch(endpoint + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hasura-admin-secret":
          process.env.MESSAGE_REQUESTS_HASURA_TEST_SECRET!,
        ...(role ? { "x-hasura-role": role, "x-hasura-user-id": "1" } : {}),
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, data: (await response.json()) as any };
  }
  const mutation = (id: number, allow = true) => ({
    query:
      "mutation($id:bigint!,$allow:Boolean!){update_players_by_pk(pk_columns:{steam_id:$id},_set:{allow_message_requests:$allow}){steam_id allow_message_requests}}",
    variables: { id, allow },
  });
  beforeAll(async () => {
    pool = new Pool({
      host: "127.0.0.1",
      port: 15437,
      user: "postgres",
      database: "deafcs_requests_qa",
    });
    const yaml = require("js-yaml");
    const table = yaml.load(
      readFileSync(
        join(
          __dirname,
          "../../hasura/metadata/databases/default/tables/public_players.yaml",
        ),
        "utf8",
      ),
    );
    const inherited = yaml.load(
      readFileSync(
        join(__dirname, "../../hasura/metadata/inherited_roles.yaml"),
        "utf8",
      ),
    );
    // Minimal synthetic players schema with every scalar column in the actual
    // permissions. Unrelated computed fields/relationships are omitted, so this
    // test exercises the unchanged role hierarchy and exact filters/checks.
    const columns = new Set<string>(
      [...table.select_permissions, ...table.update_permissions].flatMap(
        (p: any) => p.permission.columns,
      ),
    );
    for (const column of columns) {
      if (!/^[a-z_]+$/.test(column)) throw Error("invalid fixture column");
      if (column === "steam_id" || column === "allow_message_requests")
        continue;
      await pool.query(
        'ALTER TABLE players ADD COLUMN IF NOT EXISTS "' + column + '" text',
      );
    }
    const select = table.select_permissions.map((p: any) => {
      const permission = { ...p.permission };
      delete permission.computed_fields;
      return { ...p, permission };
    });
    const result = await api("/v1/metadata", {
      type: "replace_metadata",
      args: {
        version: 3,
        inherited_roles: inherited,
        sources: [
          {
            name: "default",
            kind: "postgres",
            configuration: {
              connection_info: {
                database_url: { from_env: "HASURA_GRAPHQL_DATABASE_URL" },
                isolation_level: "read-committed",
                use_prepared_statements: true,
              },
            },
            tables: [
              {
                table: table.table,
                select_permissions: select,
                update_permissions: table.update_permissions,
              },
            ],
          },
        ],
      },
    });
    expect(result.status).toBe(200);
    expect(
      (
        await api("/v1/metadata", {
          type: "get_inconsistent_metadata",
          args: {},
        })
      ).data.is_consistent,
    ).toBe(true);
  }, 30000);
  beforeEach(async () => {
    await pool.query("UPDATE players SET allow_message_requests=false");
  });
  afterAll(async () => {
    await pool?.end();
  });
  it.each(roles)(
    "%s reads the new field and saves only its own consent",
    async (role) => {
      const result = await api("/v1/graphql", mutation(1), role);
      expect(result.data.errors).toBeUndefined();
      expect(result.data.data.update_players_by_pk.allow_message_requests).toBe(
        true,
      );
      const other = await api("/v1/graphql", mutation(2), role);
      expect(other.data.data?.update_players_by_pk ?? null).toBeNull();
      expect(
        (
          await pool.query(
            "SELECT allow_message_requests FROM players WHERE steam_id=2",
          )
        ).rows[0].allow_message_requests,
      ).toBe(false);
      const read = await api(
        "/v1/graphql",
        { query: "{players_by_pk(steam_id:1){allow_message_requests}}" },
        role,
      );
      expect(read.data.data.players_by_pk.allow_message_requests).toBe(true);
    },
  );
  it("guest cannot read or mutate consent", async () => {
    expect(
      (
        await api(
          "/v1/graphql",
          { query: "{players_by_pk(steam_id:1){allow_message_requests}}" },
          "guest",
        )
      ).data.errors,
    ).toBeDefined();
    expect(
      (await api("/v1/graphql", mutation(1), "guest")).data.errors,
    ).toBeDefined();
  });
  it.each(roles)(
    "%s cannot query server-only conversation or ledger tables",
    async (role) => {
      expect(
        (
          await api(
            "/v1/graphql",
            {
              query:
                "{direct_messages{id} direct_conversations{room_id} chat_read_state{thread}}",
            },
            role,
          )
        ).data.errors,
      ).toBeDefined();
    },
  );
});
