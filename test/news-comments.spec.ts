import { PostgresService } from "../src/postgres/postgres.service";
import { Fixtures } from "./utils/fixtures";
import { bootMigratedDb, SqlTestDb } from "./utils/sql-test-db";

// DEAFCS-only News comments (migration 1890000001100, functions/news,
// triggers/news_comments.sql). These are the rules that must hold even if
// the API is bypassed: the 7-day window, one reply level, no self-votes,
// vote counts, the 10-minute edit window, soft delete and what readers see.

describe("news comments schema", () => {
  let db: SqlTestDb;
  let postgres: PostgresService;
  let fx: Fixtures;
  let seq = 0;

  beforeAll(async () => {
    db = await bootMigratedDb("NewsCommentsTest");
    postgres = db.postgres;
    fx = new Fixtures(postgres, 76561199963000000n);
  }, 600_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    // TRUNCATE, not DELETE: taking back a +1 on a closed thread is blocked
    // by design, and an earlier test leaves closed threads behind.
    await postgres.query("TRUNCATE news_comment_votes, news_comments");
    await postgres.query("DELETE FROM notifications");
    await postgres.query("DELETE FROM news_articles");
  });

  async function article(
    publishedAgo: string | null = "1 day",
    status = "published",
  ): Promise<string> {
    seq += 1;
    const [row] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO news_articles (slug, title, status, published_at)
       VALUES ($1, $2, $3, CASE WHEN $4::text IS NULL THEN NULL ELSE now() - $4::interval END)
       RETURNING id`,
      [`post-${seq}`, `Post ${seq}`, status, publishedAgo],
    );
    return row.id;
  }

  async function comment(
    articleId: string,
    author: string,
    body = "Nice post",
    parentId: string | null = null,
  ): Promise<string> {
    const [row] = await postgres.query<Array<{ id: string }>>(
      `INSERT INTO news_comments (article_id, parent_id, author_steam_id, body)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [articleId, parentId, author, body],
    );
    return row.id;
  }

  async function voteCount(id: string): Promise<number> {
    const [row] = await postgres.query<Array<{ vote_count: number }>>(
      `SELECT vote_count FROM news_comments WHERE id = $1`,
      [id],
    );
    return Number(row.vote_count);
  }

  it("installs the tables, the reply notification type and the window function", async () => {
    const [state] = await postgres.query<
      Array<{ comments: string; votes: string; type: string }>
    >(
      `SELECT to_regclass('public.news_comments')::text AS comments,
              to_regclass('public.news_comment_votes')::text AS votes,
              (SELECT value FROM e_notification_types WHERE value = 'NewsCommentReply') AS type`,
    );
    expect(state).toEqual({
      comments: "news_comments",
      votes: "news_comment_votes",
      type: "NewsCommentReply",
    });
  });

  describe("7-day window", () => {
    it("is open for 7 days after publication only", async () => {
      const fresh = await article("6 days 23 hours");
      const old = await article("7 days 1 minute");
      const draft = await article(null, "draft");
      const [row] = await postgres.query<
        Array<{ fresh: boolean; old: boolean; draft: boolean }>
      >(
        `SELECT news_comments_open($1) AS fresh, news_comments_open($2) AS old,
                news_comments_open($3) AS draft`,
        [fresh, old, draft],
      );
      expect(row).toEqual({ fresh: true, old: false, draft: false });
    });

    it("rejects new comments and replies once closed, keeping old ones", async () => {
      const player = await fx.player("Commenter");
      const id = await article("1 day");
      const kept = await comment(id, player);

      await postgres.query(
        `UPDATE news_articles SET published_at = now() - interval '8 days' WHERE id = $1`,
        [id],
      );

      await expect(comment(id, player)).rejects.toThrow(
        "Comments are closed for this article",
      );
      await expect(comment(id, player, "reply", kept)).rejects.toThrow(
        "Comments are closed for this article",
      );
      const [{ count }] = await postgres.query<Array<{ count: number }>>(
        `SELECT count(*)::int AS count FROM news_comments WHERE article_id = $1`,
        [id],
      );
      expect(count).toBe(1);
    });

    it("locks adding and taking back +1s once closed", async () => {
      const author = await fx.player("Author");
      const voter = await fx.player("Voter");
      const other = await fx.player("Other");
      const id = await article("1 day");
      const c = await comment(id, author);
      await postgres.query(
        `INSERT INTO news_comment_votes (comment_id, steam_id) VALUES ($1, $2)`,
        [c, voter],
      );
      await postgres.query(
        `UPDATE news_articles SET published_at = now() - interval '8 days' WHERE id = $1`,
        [id],
      );

      await expect(
        postgres.query(
          `INSERT INTO news_comment_votes (comment_id, steam_id) VALUES ($1, $2)`,
          [c, other],
        ),
      ).rejects.toThrow("Comments are closed for this article");
      await expect(
        postgres.query(
          `DELETE FROM news_comment_votes WHERE comment_id = $1 AND steam_id = $2`,
          [c, voter],
        ),
      ).rejects.toThrow("Comments are closed for this article");
      expect(await voteCount(c)).toBe(1);
    });

    it("still lets authors delete and staff hide or restore after it closes", async () => {
      const author = await fx.player("Author");
      const moderator = await fx.player("Moderator");
      const id = await article("1 day");
      const a = await comment(id, author, "first");
      const b = await comment(id, author, "second");
      await postgres.query(
        `UPDATE news_articles SET published_at = now() - interval '30 days' WHERE id = $1`,
        [id],
      );

      await postgres.query(
        `UPDATE news_comments SET deleted_at = now() WHERE id = $1`,
        [a],
      );
      await postgres.query(
        `UPDATE news_comments SET hidden_at = now(), hidden_by_steam_id = $2, hidden_reason = 'spam' WHERE id = $1`,
        [b, moderator],
      );
      await postgres.query(
        `UPDATE news_comments SET hidden_at = NULL, hidden_by_steam_id = NULL, hidden_reason = NULL WHERE id = $1`,
        [b],
      );
      const rows = await postgres.query<
        Array<{ id: string; deleted: boolean; hidden: boolean }>
      >(
        `SELECT id, deleted_at IS NOT NULL AS deleted, hidden_at IS NOT NULL AS hidden
           FROM news_comments ORDER BY body`,
      );
      expect(rows).toEqual([
        { id: a, deleted: true, hidden: false },
        { id: b, deleted: false, hidden: false },
      ]);
    });

    it("never opens on an unpublished article", async () => {
      const player = await fx.player();
      const id = await article("1 hour", "draft");
      await expect(comment(id, player)).rejects.toThrow(
        "Comments are closed for this article",
      );
    });
  });

  describe("replies", () => {
    it("allows one level under a comment of the same article", async () => {
      const a = await fx.player("A");
      const b = await fx.player("B");
      const id = await article();
      const parent = await comment(id, a);
      const reply = await comment(id, b, "reply", parent);

      await expect(comment(id, a, "deeper", reply)).rejects.toThrow(
        "Replies can only answer a top-level comment",
      );

      const otherArticle = await article();
      await expect(comment(otherArticle, b, "wrong", parent)).rejects.toThrow(
        "Reply must belong to a comment on the same article",
      );
    });

    it("cannot answer a deleted or hidden comment", async () => {
      const a = await fx.player("A");
      const b = await fx.player("B");
      const id = await article();
      const deleted = await comment(id, a, "x");
      const hidden = await comment(id, a, "y");
      await postgres.query(
        `UPDATE news_comments SET deleted_at = now() WHERE id = $1`,
        [deleted],
      );
      await postgres.query(
        `UPDATE news_comments SET hidden_at = now() WHERE id = $1`,
        [hidden],
      );
      await expect(comment(id, b, "r", deleted)).rejects.toThrow(
        "can no longer be replied to",
      );
      await expect(comment(id, b, "r", hidden)).rejects.toThrow(
        "can no longer be replied to",
      );
    });
  });

  describe("+1", () => {
    it("is one per player, never on your own comment, and keeps the count", async () => {
      const author = await fx.player("Author");
      const v1 = await fx.player("V1");
      const v2 = await fx.player("V2");
      const id = await article();
      const c = await comment(id, author);

      await postgres.query(
        `INSERT INTO news_comment_votes (comment_id, steam_id) VALUES ($1, $2), ($1, $3)`,
        [c, v1, v2],
      );
      expect(await voteCount(c)).toBe(2);

      await expect(
        postgres.query(
          `INSERT INTO news_comment_votes (comment_id, steam_id) VALUES ($1, $2)`,
          [c, v1],
        ),
      ).rejects.toThrow(/duplicate key/);
      await expect(
        postgres.query(
          `INSERT INTO news_comment_votes (comment_id, steam_id) VALUES ($1, $2)`,
          [c, author],
        ),
      ).rejects.toThrow("You cannot +1 your own comment");

      await postgres.query(
        `DELETE FROM news_comment_votes WHERE comment_id = $1 AND steam_id = $2`,
        [c, v1],
      );
      expect(await voteCount(c)).toBe(1);
    });

    it("cannot +1 a deleted or hidden comment", async () => {
      const author = await fx.player("Author");
      const voter = await fx.player("Voter");
      const id = await article();
      const c = await comment(id, author);
      await postgres.query(
        `UPDATE news_comments SET hidden_at = now() WHERE id = $1`,
        [c],
      );
      await expect(
        postgres.query(
          `INSERT INTO news_comment_votes (comment_id, steam_id) VALUES ($1, $2)`,
          [c, voter],
        ),
      ).rejects.toThrow("can no longer be voted on");
    });

    it("lets a deleted article take its comments and votes with it, even when closed", async () => {
      const author = await fx.player("Author");
      const voter = await fx.player("Voter");
      const id = await article();
      const c = await comment(id, author);
      await comment(id, voter, "reply", c);
      await postgres.query(
        `INSERT INTO news_comment_votes (comment_id, steam_id) VALUES ($1, $2)`,
        [c, voter],
      );
      await postgres.query(
        `UPDATE news_articles SET published_at = now() - interval '30 days' WHERE id = $1`,
        [id],
      );

      await postgres.query(`DELETE FROM news_articles WHERE id = $1`, [id]);
      const [{ comments, votes }] = await postgres.query<
        Array<{ comments: number; votes: number }>
      >(
        `SELECT (SELECT count(*)::int FROM news_comments) AS comments,
                (SELECT count(*)::int FROM news_comment_votes) AS votes`,
      );
      expect({ comments, votes }).toEqual({ comments: 0, votes: 0 });
    });
  });

  describe("edits and deletes", () => {
    it("allows text edits for 10 minutes and marks them edited", async () => {
      const author = await fx.player();
      const id = await article();
      const c = await comment(id, author, "typo");

      await postgres.query(
        `UPDATE news_comments SET body = '  fixed  ' WHERE id = $1`,
        [c],
      );
      const [edited] = await postgres.query<
        Array<{ body: string; edited: boolean }>
      >(
        `SELECT body, edited_at IS NOT NULL AS edited FROM news_comments WHERE id = $1`,
        [c],
      );
      expect(edited).toEqual({ body: "fixed", edited: true });

      // Age the comment past the window (bypassing the "cannot move" rule
      // the way only a migration could).
      await postgres.query(
        `ALTER TABLE news_comments DISABLE TRIGGER tbu_news_comments`,
      );
      await postgres.query(
        `UPDATE news_comments SET created_at = now() - interval '11 minutes' WHERE id = $1`,
        [c],
      );
      await postgres.query(
        `ALTER TABLE news_comments ENABLE TRIGGER tbu_news_comments`,
      );
      await expect(
        postgres.query(`UPDATE news_comments SET body = 'late' WHERE id = $1`, [
          c,
        ]),
      ).rejects.toThrow("Comments can only be edited for 10 minutes");
    });

    it("keeps a deleted comment deleted and its text unchangeable", async () => {
      const author = await fx.player();
      const id = await article();
      const c = await comment(id, author);
      await postgres.query(
        `UPDATE news_comments SET deleted_at = now() WHERE id = $1`,
        [c],
      );
      await expect(
        postgres.query(`UPDATE news_comments SET body = 'x' WHERE id = $1`, [c]),
      ).rejects.toThrow("can no longer be edited");
      await expect(
        postgres.query(
          `UPDATE news_comments SET deleted_at = NULL WHERE id = $1`,
          [c],
        ),
      ).rejects.toThrow("A deleted comment cannot be restored");
    });

    it("rejects empty and over-long text", async () => {
      const author = await fx.player();
      const id = await article();
      await expect(comment(id, author, "   ")).rejects.toThrow(
        /news_comments_body_length/,
      );
      await expect(comment(id, author, "x".repeat(2001))).rejects.toThrow(
        /news_comments_body_length/,
      );
    });
  });

  describe("what readers see", () => {
    const session = (role: string) => JSON.stringify({ "x-hasura-role": role });

    it("hides the text of hidden comments from readers but not from staff, and of deleted ones from everyone", async () => {
      const author = await fx.player();
      const id = await article();
      const visible = await comment(id, author, "visible");
      const hidden = await comment(id, author, "rude");
      const deleted = await comment(id, author, "gone");
      await postgres.query(
        `UPDATE news_comments SET hidden_at = now() WHERE id = $1`,
        [hidden],
      );
      await postgres.query(
        `UPDATE news_comments SET deleted_at = now() WHERE id = $1`,
        [deleted],
      );

      const textFor = async (role: string) =>
        Object.fromEntries(
          (
            await postgres.query<Array<{ id: string; text: string | null }>>(
              `SELECT c.id, news_comment_visible_body(c, $1::json) AS text
                 FROM news_comments c`,
              [session(role)],
            )
          ).map((row) => [row.id, row.text]),
        );

      for (const role of ["guest", "user", "verified_user", "streamer"]) {
        expect(await textFor(role)).toEqual({
          [visible]: "visible",
          [hidden]: null,
          [deleted]: null,
        });
      }
      for (const role of ["moderator", "administrator"]) {
        expect(await textFor(role)).toEqual({
          [visible]: "visible",
          [hidden]: "rude",
          [deleted]: null,
        });
      }
    });
  });
});
