import path from "path";
import { GenericContainer, StartedTestContainer, Wait } from "testcontainers";
import { bootContainerAndMigrate, SqlTestDb } from "./utils/sql-test-db";
import {
  NoSteamAccountAvailableError,
  SteamAccountService,
} from "../src/matches/game-streamer/steam-account.service";

// The GPU rendering pool is the role = 'gpu' steam_accounts rows. A Steam
// Presence bot (role = 'friends') lives in the same table but must never be
// claimed for GPU work, counted in the GPU pool, or listed / deleted from the
// GPU Nodes page. The WEB documents below are the ones the GPU Nodes page and
// the left nav send, run on the production engine with this repo's metadata.
const HASURA_IMAGE = "hasura/graphql-engine:v2.49.4-ce.cli-migrations-v3";

const NODE = "gpu-pool-node-1";
const GPU_ID = "11111111-1111-4111-8111-111111111111";
const FRIENDS_ID = "22222222-2222-4222-8222-222222222222";

const gpuNodesAccountsQuery = `query {
  steam_accounts(where: {role: {_eq: "gpu"}}, order_by: [{created_at: asc}]) {
    id
    username
    last_node_id
    claims { purpose node_id k8s_job_name created_at }
  }
}`;

const poolStatusQuery = `query {
  v_steam_account_pool_status(limit: 1) { total_accounts free_accounts busy_accounts }
}`;

const leftNavQuery = `query {
  game_server_nodes(where: {gpu: {_eq: true}}) { id }
  steam_accounts(where: {role: {_eq: "gpu"}}) { id }
}`;

describe("GPU Steam pool only uses role = 'gpu' accounts", () => {
  let db: SqlTestDb;
  let hasura: StartedTestContainer;
  let endpoint: string;
  let steamAccounts: SteamAccountService;
  const adminSecret = "gpu-steam-pool-local-test";

  async function gql(query: string, variables?: Record<string, unknown>) {
    const response = await fetch(`${endpoint}/v1/graphql`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hasura-admin-secret": adminSecret,
        "x-hasura-role": "administrator",
        "x-hasura-user-id": "76561199966000001",
      },
      body: JSON.stringify({ query, variables }),
    });
    return (await response.json()) as { data?: any; errors?: any[] };
  }

  async function rowCount(id: string) {
    const rows = await db.postgres.query<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM steam_accounts WHERE id = $1`,
      [id],
    );
    return rows[0].n;
  }

  beforeAll(async () => {
    db = await bootContainerAndMigrate("GpuSteamPoolRoleHasura");
    steamAccounts = new SteamAccountService(db.postgres);
    await db.postgres.query(
      "INSERT INTO players (steam_id, name, role) VALUES (76561199966000001, 'Admin', 'administrator')",
    );
    await db.postgres.query(
      "INSERT INTO server_regions (value, is_lan) VALUES ('GpuRegion', false) ON CONFLICT (value) DO NOTHING",
    );
    await db.postgres.query(
      `INSERT INTO game_server_nodes (id, region, gpu) VALUES ($1, 'GpuRegion', true)`,
      [NODE],
    );

    const c = db.container!;
    const databaseUrl = `postgres://${c.getUsername()}:${c.getPassword()}@host.docker.internal:${c.getPort()}/${c.getDatabase()}`;
    hasura = await new GenericContainer(HASURA_IMAGE)
      .withEnvironment({
        HASURA_GRAPHQL_DATABASE_URL: databaseUrl,
        HASURA_GRAPHQL_ADMIN_SECRET: adminSecret,
        HASURA_GRAPHQL_ACTIONS_HOOK: "http://host.docker.internal:3000",
        HASURA_GRAPHQL_EVENT_HOOK: "http://host.docker.internal:3000/events",
        HASURA_GRAPHQL_STRINGIFY_NUMERIC_TYPES: "true",
      })
      .withBindMounts([
        {
          source: path.resolve("hasura/metadata"),
          target: "/hasura-metadata",
          mode: "ro",
        },
      ])
      .withExposedPorts(8080)
      .withWaitStrategy(Wait.forHttp("/healthz", 8080).forStatusCode(200))
      .withStartupTimeout(240_000)
      .start();
    endpoint = `http://${hasura.getHost()}:${hasura.getMappedPort(8080)}`;
  }, 600_000);

  beforeEach(async () => {
    await db.postgres.query(`DELETE FROM steam_account_claims`);
    await db.postgres.query(`DELETE FROM steam_accounts`);
    await db.postgres.query(
      `INSERT INTO steam_accounts (id, username, password, role, created_at)
       VALUES ($1, 'render-1', 'x', 'gpu', now() - interval '2 days'),
              ($2, 'presence-bot', 'y', 'friends', now() - interval '1 day')`,
      [GPU_ID, FRIENDS_ID],
    );
  });

  afterAll(async () => {
    await hasura?.stop();
    await db?.stop();
  });

  it("loads the full metadata consistently", async () => {
    const response = await fetch(`${endpoint}/v1/metadata`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hasura-admin-secret": adminSecret,
      },
      body: JSON.stringify({ type: "get_inconsistent_metadata", args: {} }),
    });
    expect(await response.json()).toEqual({
      is_consistent: true,
      inconsistent_objects: [],
    });
  });

  it("claims the gpu account and never the friends bot", async () => {
    const first = await steamAccounts.claim({
      nodeId: NODE,
      jobName: "render-job-1",
      purpose: "highlights",
    });
    expect(first.id).toBe(GPU_ID);

    await expect(
      steamAccounts.claim({
        nodeId: NODE,
        jobName: "render-job-2",
        purpose: "highlights",
      }),
    ).rejects.toBeInstanceOf(NoSteamAccountAvailableError);
  });

  it("skips the friends bot even when it last ran on the node", async () => {
    await db.postgres.query(
      `UPDATE steam_accounts SET last_node_id = $1 WHERE id = $2`,
      [NODE, FRIENDS_ID],
    );
    const claimed = await steamAccounts.claim({
      nodeId: NODE,
      jobName: "render-job-3",
      purpose: "demo",
    });
    expect(claimed.id).toBe(GPU_ID);
  });

  it("counts only gpu accounts in the pool status", async () => {
    let result = await gql(poolStatusQuery);
    expect(result.errors).toBeUndefined();
    expect(result.data.v_steam_account_pool_status).toEqual([
      { total_accounts: 1, free_accounts: 1, busy_accounts: 0 },
    ]);

    await steamAccounts.claim({
      nodeId: NODE,
      jobName: "render-job-4",
      purpose: "live",
    });
    result = await gql(poolStatusQuery);
    expect(result.data.v_steam_account_pool_status).toEqual([
      { total_accounts: 1, free_accounts: 0, busy_accounts: 1 },
    ]);
  });

  it("lists only gpu accounts with the GPU Nodes query", async () => {
    const result = await gql(gpuNodesAccountsQuery);
    expect(result.errors).toBeUndefined();
    expect(result.data.steam_accounts.map((a: any) => a.id)).toEqual([GPU_ID]);
  });

  it("counts only gpu accounts with the left nav query", async () => {
    const result = await gql(leftNavQuery);
    expect(result.errors).toBeUndefined();
    expect(result.data.game_server_nodes).toEqual([{ id: NODE }]);
    expect(result.data.steam_accounts).toEqual([{ id: GPU_ID }]);
  });

  it("adds new accounts from the GPU Nodes page as gpu", async () => {
    const result = await gql(
      `mutation ($u: String!, $p: String!) {
        insert_steam_accounts_one(object: {username: $u, password: $p}) { id role }
      }`,
      { u: "render-2", p: "z" },
    );
    expect(result.errors).toBeUndefined();
    expect(result.data.insert_steam_accounts_one.role).toBe("gpu");
  });

  it("cannot delete or edit the friends bot through Hasura", async () => {
    const del = await gql(
      `mutation ($id: uuid!) { delete_steam_accounts_by_pk(id: $id) { id } }`,
      { id: FRIENDS_ID },
    );
    expect(del.errors).toBeUndefined();
    expect(del.data.delete_steam_accounts_by_pk).toBeNull();

    const upd = await gql(
      `mutation ($id: uuid!) {
        update_steam_accounts_by_pk(pk_columns: {id: $id}, _set: {password: "changed"}) { id }
      }`,
      { id: FRIENDS_ID },
    );
    expect(upd.errors).toBeUndefined();
    expect(upd.data.update_steam_accounts_by_pk).toBeNull();

    const rows = await db.postgres.query<Array<{ password: string }>>(
      `SELECT password FROM steam_accounts WHERE id = $1`,
      [FRIENDS_ID],
    );
    expect(rows).toEqual([{ password: "y" }]);
  });

  it("still deletes a gpu account from the GPU Nodes page", async () => {
    const del = await gql(
      `mutation ($id: uuid!) { delete_steam_accounts_by_pk(id: $id) { id } }`,
      { id: GPU_ID },
    );
    expect(del.errors).toBeUndefined();
    expect(del.data.delete_steam_accounts_by_pk).toEqual({ id: GPU_ID });
    expect(await rowCount(GPU_ID)).toBe(0);
    expect(await rowCount(FRIENDS_ID)).toBe(1);
  });
});
