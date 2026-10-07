import fs from "fs";
import path from "path";
import os from "os";
import { execFileSync } from "child_process";
import { load } from "js-yaml";
import WebSocket from "ws";
import { GenericContainer, StartedTestContainer, Wait } from "testcontainers";
import { bootContainerAndMigrate, SqlTestDb } from "./utils/sql-test-db";
import { Fixtures } from "./utils/fixtures";

// Validate the actual WEB selectors, not a hand-maintained approximation.
function currentWebFriendDocuments() {
  const web = path.resolve("../deafcs-web");
  const ts = require(path.join(web, "node_modules/typescript"));
  const { Zeus } = (() => {
    const constModule = { exports: {} as any };
    const indexModule = { exports: {} as any };
    const compile = (file: string) => ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    new Function("module", "exports", compile(path.join(web, "generated/zeus/const.ts")))(constModule, constModule.exports);
    new Function("module", "exports", "require", compile(path.join(web, "generated/zeus/index.ts")))(indexModule, indexModule.exports, () => constModule.exports);
    return indexModule.exports;
  })();
  const documents: Array<{ file: string; operation: string; query: string }> = [];
  for (const file of ["stores/MatchmakingStore.ts", "composables/useFriendActions.ts", "components/notification/ActionToasts.vue", "components/matchmaking-lobby/FriendOptions.vue"]) {
    const content = fs.readFileSync(path.join(web, file), "utf8");
    const script = file.endsWith(".vue") ? [...content.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).join("\n") : content;
    const source = ts.createSourceFile(file, script, ts.ScriptTarget.Latest, true);
    function visit(node: any) {
      if (ts.isCallExpression(node) && node.arguments.length && ts.isObjectLiteralExpression(node.arguments[0]) && /my_friends/.test(node.arguments[0].getText(source))) {
        const callee = node.expression.getText(source);
        const operation = callee === "generateSubscription" ? "subscription" : callee === "generateMutation" || callee === 'typedGql("mutation")' ? "mutation" : undefined;
        if (operation) {
          const expression = ts.transpileModule(`const input = ${node.arguments[0].getText(source)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
          for (const accept of callee === "generateMutation" ? [true, false] : [false]) {
            const enumValues = new Proxy({}, { get: (_, key) => String(key) });
            const input = new Function("accept", "steamId", "steam_id", "sid", "e_match_status_enum", "e_draft_game_status_enum", "e_lobby_access_enum", "order_by", `${expression}; return input;`).call({ player: { steam_id: "76561199971000000" } }, accept, "76561199971000000", "76561199971000000", String, enumValues, enumValues, enumValues, enumValues);
            documents.push({ file, operation, query: Zeus(operation, input) });
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return documents;
}

const columns = ["steam_id", "name", "avatar_url", "custom_avatar_url", "country", "created_at", "discord_id", "name_registered", "profile_url", "role", "status", "friend_steam_id", "invited_by_steam_id", "elo", "last_presence_state", "presence_updated_at"];
const viewFile = path.resolve("hasura/views/v_my_friends.sql");
const metadata = load(fs.readFileSync(path.resolve("hasura/metadata/databases/default/tables/public_v_my_friends.yaml"), "utf8")) as any;

describe("deterministic my_friends view and unchanged permissions", () => {
  let db: SqlTestDb;
  let hasura: StartedTestContainer;
  let endpoint: string;
  let a: string;
  let b: string;
  let outsider: string;
  // Disposable local test credentials only, never production credentials.
  const adminSecret = "my-friends-local-test";
  async function request(route: string, body: unknown, user?: string) {
    const response = await fetch(`${endpoint}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hasura-admin-secret": adminSecret, ...(user ? { "x-hasura-role": "user", "x-hasura-user-id": user } : {}) },
      body: JSON.stringify(body),
    });
    return response.json() as Promise<any>;
  }
  const gql = (query: string, user?: string) => request("/v1/graphql", { query }, user);
  const subscribeOnce = (query: string, user: string) => new Promise<any>((resolve, reject) => {
    const socket = new WebSocket(endpoint.replace("http", "ws") + "/v1/graphql", "graphql-ws");
    const timer = setTimeout(() => { socket.terminate(); reject(new Error("Local friends subscription timed out")); }, 20_000);
    socket.on("open", () => socket.send(JSON.stringify({ type: "connection_init", payload: { headers: { "x-hasura-admin-secret": adminSecret, "x-hasura-role": "user", "x-hasura-user-id": user } } })));
    socket.on("message", data => {
      const message = JSON.parse(data.toString());
      if (message.type === "connection_ack") socket.send(JSON.stringify({ id: "friends", type: "start", payload: { query } }));
      if (["data", "error", "connection_error"].includes(message.type)) {
        clearTimeout(timer); socket.close();
        if (message.type === "data") resolve(message.payload); else reject(new Error("Local Hasura subscription rejected"));
      }
    });
    socket.on("error", error => { clearTimeout(timer); socket.close(); reject(error); });
  });
  beforeAll(async () => {
    db = await bootContainerAndMigrate("MyFriendsSchema");
    const fx = new Fixtures(db.postgres, 76561199971000000n);
    [a, b, outsider] = await fx.players(3);
    const databaseUrl = `postgres://${db.container!.getUsername()}:${db.container!.getPassword()}@host.docker.internal:${db.container!.getPort()}/${db.container!.getDatabase()}`;
    hasura = await new GenericContainer("hasura/graphql-engine:v2.48.5.cli-migrations-v3")
      .withEnvironment({ HASURA_GRAPHQL_DATABASE_URL: databaseUrl, HASURA_GRAPHQL_ADMIN_SECRET: adminSecret, HASURA_GRAPHQL_ACTIONS_HOOK: "http://host.docker.internal:3000", HASURA_GRAPHQL_EVENT_HOOK: "http://host.docker.internal:3000/events", HASURA_GRAPHQL_STRINGIFY_NUMERIC_TYPES: "true" })
      .withBindMounts([{ source: path.resolve("hasura/metadata"), target: "/hasura-metadata", mode: "ro" }])
      .withExposedPorts(8080).withWaitStrategy(Wait.forHttp("/healthz", 8080).forStatusCode(200)).start();
    endpoint = `http://${hasura.getHost()}:${hasura.getMappedPort(8080)}`;
  }, 600_000);
  afterAll(async () => { await hasura?.stop(); await db?.stop(); });
  beforeEach(async () => { await db.postgres.query("DELETE FROM friends"); });

  it("contains exactly the intended physical columns on fresh installs", async () => {
    const actual = await db.postgres.query<Array<{ column_name: string }>>("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='v_my_friends' ORDER BY ordinal_position");
    expect(actual.map(row => row.column_name)).toEqual(columns);
    expect(fs.readFileSync(viewFile, "utf8")).not.toMatch(/\bp\.\*/);
  });
  it("reconciles a stale existing view via the real hash-based setup path, keeping data and all three triggers", async () => {
    await db.postgres.query("INSERT INTO friends (player_steam_id, other_player_steam_id, status) VALUES ($1,$2,'Pending')", [a, b]);
    const old = fs.readFileSync(viewFile, "utf8").replace(/  -- Keep the friend contract explicit:[\s\S]*?  p\.role,/, "  p.*,");
    await db.postgres.query(`BEGIN;${old};COMMIT;`);
    const key = path.relative(process.cwd(), viewFile.replace(".sql", ""));
    await db.hasura.setSetting(key, db.hasura.calcSqlDigest(old));
    await db.hasura.apply(viewFile);
    const actual = await db.postgres.query<Array<{ column_name: string }>>("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='v_my_friends' ORDER BY ordinal_position");
    expect(actual.map(row => row.column_name)).toEqual(columns);
    const triggers = await db.postgres.query<Array<{ tgname: string }>>("SELECT tgname FROM pg_trigger WHERE tgrelid='public.v_my_friends'::regclass AND NOT tgisinternal ORDER BY tgname");
    expect(triggers.map(row => row.tgname)).toEqual(["td_v_my_friends", "ti_v_my_friends", "tu_v_my_friends"]);
    expect(await db.postgres.query("SELECT status FROM friends WHERE player_steam_id=$1 AND other_player_steam_id=$2", [a, b])).toEqual([{ status: "Pending" }]);
    await db.postgres.query("DELETE FROM friends WHERE player_steam_id=$1 AND other_player_steam_id=$2", [a,b]);
    await request("/v1/metadata", { type: "reload_metadata", args: {} });
  }, 60_000);
  it("keeps metadata consistent and user select exactly scoped to existing columns", async () => {
    expect(await request("/v1/metadata", { type: "get_inconsistent_metadata", args: {} })).toEqual({ is_consistent: true, inconsistent_objects: [] });
    const permission = metadata.select_permissions.find((entry: any) => entry.role === "user").permission;
    expect([...permission.columns].sort()).toEqual(columns.filter(c => c !== "friend_steam_id").sort());
    expect(permission.filter).toEqual({ friend_steam_id: { _eq: "X-Hasura-User-Id" } });
    for (const user of [undefined, a]) {
      const type = await gql('{ __type(name: "my_friends") { fields { name } } }', user);
      expect(type.errors).toBeUndefined();
      const fields = type.data.__type.fields.map((f: any) => f.name);
      for (const field of ["api_key_enabled", "api_key", "twitch_channel", "faceit_last_match_at", "faceit_refresh_attempted_at", "last_seen_at"]) expect(fields).not.toContain(field);
    }
  });
  it("supports insert, incoming/outgoing reads, accept, cancel, decline and remove through user GraphQL", async () => {
    const add = () => gql(`mutation { insert_my_friends_one(object: {steam_id:"${b}"}) {steam_id} }`, a);
    const remove = (user: string, other: string) => gql(`mutation { delete_my_friends(where:{steam_id:{_eq:"${other}"}}) {affected_rows} }`, user);
    for (const action of ["cancel", "decline", "remove"]) {
      expect((await add()).errors).toBeUndefined();
      for (const user of [a,b]) {
        const read = await subscribeOnce("subscription { my_friends { steam_id status invited_by_steam_id name role elo country avatar_url custom_avatar_url last_presence_state presence_updated_at player { steam_id is_in_lobby is_in_another_match is_in_draft } } }", user);
        expect(read.errors).toBeUndefined();
        expect(read.data.my_friends).toHaveLength(1);
        expect(read.data.my_friends[0]).toMatchObject({ status: "Pending", invited_by_steam_id: a });
      }
      expect((await gql("query { my_friends { steam_id } }", outsider)).data.my_friends).toEqual([]);
      if (action === "remove") {
        expect((await gql(`mutation { update_my_friends(where:{steam_id:{_eq:"${a}"}}) {affected_rows} }`, b)).errors).toBeUndefined();
        expect((await gql("query { my_friends { status } }", a)).data.my_friends[0].status).toBe("Accepted");
      }
      expect((await remove(action === "cancel" ? a : b, action === "cancel" ? b : a)).errors).toBeUndefined();
      expect((await gql("query { my_friends { steam_id } }", a)).data.my_friends).toEqual([]);
    }
  }, 60_000);
  it("retains Steam presence and validates current friend GraphQL reads", async () => {
    await db.postgres.query("INSERT INTO friends (player_steam_id,other_player_steam_id,status) VALUES ($1,$2,'Accepted')", [a,b]);
    await db.postgres.query("INSERT INTO player_steam_bot_friend (steam_id,status,last_presence_state,updated_at) VALUES ($1,'friends','{\"game_id\":\"730\"}',now()) ON CONFLICT (steam_id) DO UPDATE SET status='friends',last_presence_state='{\"game_id\":\"730\"}',updated_at=now()", [b]);
    const result = await gql("query { my_friends { steam_id last_presence_state presence_updated_at player { steam_id is_in_lobby is_in_another_match is_in_draft lobby_players(limit:1,where:{status:{_eq:Accepted}}) { lobby_id lobby {id access players(where:{status:{_eq:Accepted}}) {steam_id} } } } } }", a);
    expect(result.errors).toBeUndefined();
    expect(result.data.my_friends[0]).toMatchObject({ steam_id: b, last_presence_state: { game_id: "730" } });
    expect(result.data.my_friends[0].presence_updated_at).toBeTruthy();
  });
  // Cross-repository review coverage is optional in API-only CI checkouts.
  (fs.existsSync(path.resolve("../deafcs-web/node_modules/typescript")) ? it : it.skip)("validates every current WEB friend operation, including full sidebar match/lobby/draft selections", async () => {
    const web = path.resolve("../deafcs-web");
    const { buildClientSchema, getIntrospectionQuery, parse, validate } = require(path.join(web, "node_modules/graphql"));
    const documents = currentWebFriendDocuments();
    expect(documents).toHaveLength(7);
    expect(new Set(documents.map(d => d.file)).size).toBe(4);
    for (const user of [undefined, a]) {
      const schema = buildClientSchema((await gql(getIntrospectionQuery(), user)).data);
      for (const document of documents) expect(validate(schema, parse(document.query)).map((e: Error) => `${document.file}: ${e.message}`)).toEqual([]);
      // Team creation dates are an already-released schema field, not a runtime change here.
      expect(validate(schema, parse('query($id: uuid!) { teams_by_pk(id: $id) { id created_at } }')).map((e: Error) => e.message)).toEqual([]);
    }
    await db.postgres.query("INSERT INTO friends (player_steam_id,other_player_steam_id,status) VALUES ($1,$2,'Accepted')", [a,b]);
    const subscription = documents.find(d => d.operation === "subscription")!;
    const result = await subscribeOnce(subscription.query, a);
    expect(result.errors).toBeUndefined();
    expect(result.data.my_friends[0]).toMatchObject({ steam_id: b, status: "Accepted" });
  }, 120_000);
  it("canonical Zeus output agrees with local Hasura (opt-in output for review)", async () => {
    if (!process.env.DEAFCS_FRIENDS_CODEGEN_DIR) return;
    const web = path.resolve("../deafcs-web");
    const output = process.env.DEAFCS_FRIENDS_CODEGEN_DIR;
    // Never overwrite the preserved WEB generated diff from this test.
    expect(path.resolve(output).startsWith(path.resolve(os.tmpdir()) + path.sep)).toBe(true);
    execFileSync(process.execPath, [path.join(web,"node_modules/graphql-zeus/lib/index.js"), `${endpoint}/v1/graphql`, output, "--ts", "--td", "--graphql", path.join(output,"schema.graphql"), `--header=x-hasura-admin-secret:${adminSecret}`], { cwd: web, stdio: "pipe" });
    const generated = fs.readFileSync(path.join(output,"zeus/const.ts"),"utf8");
    const friendsType = generated.slice(generated.indexOf("export const ReturnTypes")).match(/\n\tmy_friends:\{([\s\S]*?)\n\t\},/)![1];
    const fields = [...friendsType.matchAll(/\n\t\t(\w+):/g)].map(match => match[1]);
    expect(fields.sort()).toEqual([...columns, "player"].sort());
  }, 120_000);
});
