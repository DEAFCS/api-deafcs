import path from "path";
import { GenericContainer, StartedTestContainer, Wait } from "testcontainers";
import { bootContainerAndMigrate, SqlTestDb } from "./utils/sql-test-db";
import { Fixtures } from "./utils/fixtures";

// DEAFCS-only News comments, through a real Hasura (production's engine
// version) loaded with the repository's full metadata: what each role can
// read and write directly, without the API in between. The rules that matter
// most: hidden and deleted comment text never leaks to readers, nobody writes
// these tables directly, and players only see their own +1s.

const HASURA_IMAGE = "hasura/graphql-engine:v2.49.4-ce.cli-migrations-v3";

describe("news comments through Hasura", () => {
  let db: SqlTestDb;
  let hasura: StartedTestContainer;
  let endpoint: string;
  // Disposable local test credentials only, never production credentials.
  const adminSecret = "news-comments-local-test";
  let author: string;
  let voter: string;
  let other: string;
  let moderator: string;
  let ids: Record<string, string>;

  async function gql(
    query: string,
    role?: string,
    user?: string,
    variables?: Record<string, unknown>,
  ) {
    const response = await fetch(`${endpoint}/v1/graphql`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hasura-admin-secret": adminSecret,
        ...(role ? { "x-hasura-role": role } : {}),
        ...(user ? { "x-hasura-user-id": user } : {}),
      },
      body: JSON.stringify({ query, variables }),
    });
    return (await response.json()) as { data?: any; errors?: any[] };
  }

  const fieldsOf = async (type: string, role: string, user?: string) => {
    const result = await gql(
      `{ __type(name: "${type}") { fields { name } } }`,
      role,
      user,
    );
    return (result.data?.__type?.fields ?? []).map((f: any) => f.name);
  };

  beforeAll(async () => {
    db = await bootContainerAndMigrate("NewsCommentsHasura");
    const fx = new Fixtures(db.postgres, 76561199964000000n);
    [author, voter, other, moderator] = await fx.players(4);

    const q = db.postgres.query.bind(db.postgres);
    const [published] = await q<Array<{ id: string }>>(
      `INSERT INTO news_articles (slug, title, status, published_at)
       VALUES ('open-post', 'Open post', 'published', now() - interval '1 day') RETURNING id`,
    );
    const [unpublished] = await q<Array<{ id: string }>>(
      `INSERT INTO news_articles (slug, title, status, published_at)
       VALUES ('pulled-post', 'Pulled post', 'published', now() - interval '1 day') RETURNING id`,
    );
    const insert = async (article: string, body: string, by: string, parent: string | null = null) =>
      (
        await q<Array<{ id: string }>>(
          `INSERT INTO news_comments (article_id, parent_id, author_steam_id, body)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [article, parent, by, body],
        )
      )[0].id;

    ids = {
      visible: await insert(published.id, "visible words", author),
      hidden: await insert(published.id, "rude secret words", author),
      deleted: await insert(published.id, "deleted secret words", author),
    };
    ids.reply = await insert(published.id, "a reply", other, ids.visible);
    ids.pulled = await insert(unpublished.id, "on a pulled post", author);

    await q(
      `UPDATE news_comments SET hidden_at = now(), hidden_by_steam_id = $2, hidden_reason = 'insults' WHERE id = $1`,
      [ids.hidden, moderator],
    );
    await q(`UPDATE news_comments SET deleted_at = now() WHERE id = $1`, [ids.deleted]);
    await q(
      `INSERT INTO news_comment_votes (comment_id, steam_id) VALUES ($1, $2), ($1, $3)`,
      [ids.visible, voter, other],
    );
    // Unpublish after commenting: its comments must disappear for everyone.
    await q(`UPDATE news_articles SET status = 'draft' WHERE id = $1`, [unpublished.id]);

    const databaseUrl = `postgres://${db.container!.getUsername()}:${db.container!.getPassword()}@host.docker.internal:${db.container!.getPort()}/${db.container!.getDatabase()}`;
    hasura = await new GenericContainer(HASURA_IMAGE)
      .withEnvironment({
        HASURA_GRAPHQL_DATABASE_URL: databaseUrl,
        HASURA_GRAPHQL_ADMIN_SECRET: adminSecret,
        HASURA_GRAPHQL_ACTIONS_HOOK: "http://host.docker.internal:3000",
        HASURA_GRAPHQL_EVENT_HOOK: "http://host.docker.internal:3000/events",
        HASURA_GRAPHQL_STRINGIFY_NUMERIC_TYPES: "true",
      })
      .withBindMounts([
        { source: path.resolve("hasura/metadata"), target: "/hasura-metadata", mode: "ro" },
      ])
      .withExposedPorts(8080)
      .withWaitStrategy(Wait.forHttp("/healthz", 8080).forStatusCode(200))
      .start();
    endpoint = `http://${hasura.getHost()}:${hasura.getMappedPort(8080)}`;
  }, 600_000);

  afterAll(async () => {
    await hasura?.stop();
    await db?.stop();
  });

  const threadQuery = `{
    news_comments(order_by: { created_at: asc }) { id text deleted_at hidden_at vote_count }
  }`;

  it("loads the full metadata consistently", async () => {
    const response = await fetch(`${endpoint}/v1/metadata`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hasura-admin-secret": adminSecret },
      body: JSON.stringify({ type: "get_inconsistent_metadata", args: {} }),
    });
    expect(await response.json()).toEqual({ is_consistent: true, inconsistent_objects: [] });
  });

  it.each([
    ["guest", undefined],
    ["user", "voter"],
    ["verified_user", "voter"],
    ["streamer", "voter"],
  ])("never shows %s hidden or deleted text, or the stored body", async (role, who) => {
    const user = who ? voter : undefined;
    const result = await gql(threadQuery, role, user);
    expect(result.errors).toBeUndefined();
    const byId = Object.fromEntries(result.data.news_comments.map((c: any) => [c.id, c.text]));
    expect(byId).toEqual({
      [ids.visible]: "visible words",
      [ids.hidden]: null,
      [ids.deleted]: null,
      [ids.reply]: "a reply",
    });
    expect(JSON.stringify(result.data)).not.toContain("secret");

    const fields = await fieldsOf("news_comments", role, user);
    expect(fields).toContain("text");
    expect(fields).not.toContain("body");
    expect(fields).not.toContain("hidden_reason");
    expect(fields).not.toContain("hidden_by_steam_id");
    expect(fields).not.toContain("reply_notified_at");

    // No way round it through filters either.
    const byBody = await gql(`{ news_comments(where: { body: { _ilike: "%secret%" } }) { id } }`, role, user);
    expect(byBody.errors?.[0]?.message ?? "").toMatch(/body/);
    const byText = await gql(`{ news_comments(where: { text: { _ilike: "%secret%" } }) { id } }`, role, user);
    if (!byText.errors) {
      expect(byText.data.news_comments).toEqual([]);
    }
  });

  it.each(["moderator", "match_organizer", "tournament_organizer", "administrator"])(
    "shows %s the hidden text, body and reason, but still not a deleted comment's text",
    async (role) => {
      const result = await gql(
        `{ news_comments(order_by: { created_at: asc }) { id text body hidden_reason } }`,
        role,
        moderator,
      );
      expect(result.errors).toBeUndefined();
      const byId = Object.fromEntries(result.data.news_comments.map((c: any) => [c.id, c]));
      expect(byId[ids.hidden]).toMatchObject({ text: "rude secret words", hidden_reason: "insults" });
      expect(byId[ids.deleted].text).toBeNull();
    },
  );

  it("hides every comment of an unpublished article from every role", async () => {
    for (const [role, user] of [
      ["guest", undefined],
      ["verified_user", voter],
      ["administrator", moderator],
    ] as const) {
      const result = await gql(
        `query($id: uuid!) { news_comments_by_pk(id: $id) { id } }`,
        role,
        user,
        { id: ids.pulled },
      );
      expect(result.errors).toBeUndefined();
      expect(result.data.news_comments_by_pk).toBeNull();
    }
  });

  it("lets a player see only their own +1s, and guests none", async () => {
    const mine = await gql(`{ news_comment_votes { comment_id steam_id } }`, "verified_user", voter);
    expect(mine.errors).toBeUndefined();
    expect(mine.data.news_comment_votes).toEqual([{ comment_id: ids.visible, steam_id: voter }]);

    const nested = await gql(
      `query($id: uuid!) { news_comments_by_pk(id: $id) { vote_count votes { steam_id } } }`,
      "user",
      voter,
      { id: ids.visible },
    );
    expect(nested.data.news_comments_by_pk).toEqual({ vote_count: 2, votes: [{ steam_id: voter }] });

    const guest = await gql(`{ news_comment_votes { steam_id } }`, "guest");
    expect(guest.errors?.length).toBeGreaterThan(0);
  });

  it("gives no role a direct insert, update or delete on either table", async () => {
    for (const [role, user] of [
      ["guest", undefined],
      ["user", voter],
      ["verified_user", voter],
      ["streamer", voter],
      ["moderator", moderator],
      ["administrator", moderator],
    ] as const) {
      const mutations = await fieldsOf("mutation_root", role, user);
      const direct = mutations.filter((name: string) =>
        /^(insert|update|delete)_news_comment/.test(name),
      );
      expect({ role, direct }).toEqual({ role, direct: [] });
    }
  });

  it("exposes the write actions to players and hiding to staff only", async () => {
    const verified = await fieldsOf("mutation_root", "verified_user", voter);
    expect(verified).toEqual(
      expect.arrayContaining(["postNewsComment", "editNewsComment", "deleteNewsComment", "toggleNewsCommentVote"]),
    );
    expect(verified).not.toContain("setNewsCommentHidden");
    expect(await fieldsOf("mutation_root", "guest")).not.toContain("postNewsComment");
    for (const role of ["moderator", "administrator"]) {
      expect(await fieldsOf("mutation_root", role, moderator)).toContain("setNewsCommentHidden");
    }
  });

  it("counts comments for readers without exposing text", async () => {
    const result = await gql(
      `{ news_comments_aggregate(where: { deleted_at: { _is_null: true }, hidden_at: { _is_null: true } }) { aggregate { count } } }`,
      "guest",
    );
    expect(result.errors).toBeUndefined();
    expect(Number(result.data.news_comments_aggregate.aggregate.count)).toBe(2);
  });
});
