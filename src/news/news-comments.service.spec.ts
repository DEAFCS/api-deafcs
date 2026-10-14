import { BadRequestException, ForbiddenException } from "@nestjs/common";
import {
  NEWS_COMMENT_RATE_LIMITS,
  NewsCommentsService,
  escapeHtml,
} from "./news-comments.service";

// DEAFCS-only News comments: the API-side rules (Anders 2026-10-14). The
// database half (window, reply depth, self-votes, counts) is covered by
// test/news-comments.spec.ts against a real Postgres.

const ARTICLE = "a0000000-0000-0000-0000-000000000001";
const verified = { steam_id: "76561190000000001", name: "Ver", role: "verified_user" } as any;
const other = { steam_id: "76561190000000002", name: "<b>Bob</b>", role: "verified_user" } as any;
const plainUser = { steam_id: "76561190000000003", name: "New", role: "user" } as any;
const moderator = { steam_id: "76561190000000004", name: "Mod", role: "moderator" } as any;
const streamer = { steam_id: "76561190000000005", name: "Str", role: "streamer" } as any;

type Comment = {
  id: string;
  article_id: string;
  parent_id: string | null;
  author_steam_id: string;
  body: string;
  vote_count: number;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  hidden_at: string | null;
  hidden_by_steam_id: string | null;
  hidden_reason: string | null;
  reply_notified_at: string | null;
};

function comment(over: Partial<Comment> = {}): Comment {
  return {
    id: "c1",
    article_id: ARTICLE,
    parent_id: null,
    author_steam_id: verified.steam_id,
    body: "first",
    vote_count: 0,
    created_at: new Date().toISOString(),
    edited_at: null,
    deleted_at: null,
    hidden_at: null,
    hidden_by_steam_id: null,
    hidden_reason: null,
    reply_notified_at: null,
    ...over,
  };
}

describe("NewsCommentsService", () => {
  let service: NewsCommentsService;
  let postgres: { query: jest.Mock };
  let notifications: { notifyPlayers: jest.Mock };
  let rates: Map<string, number>;
  let state: {
    article: { open: boolean; status: string } | null;
    comments: Map<string, Comment>;
    sanctions: string[];
    votes: Set<string>;
    claimed: Set<string>;
  };

  beforeEach(() => {
    rates = new Map();
    state = {
      article: { open: true, status: "published" },
      comments: new Map([["c1", comment()]]),
      sanctions: [],
      votes: new Set(),
      claimed: new Set(),
    };
    postgres = {
      query: jest.fn(async (sql: string, params: any[] = []) => {
        if (sql.includes("FROM public.player_sanctions")) {
          return state.sanctions.map((type) => ({ type }));
        }
        if (sql.includes("FROM public.news_articles")) {
          return state.article
            ? [{ id: ARTICLE, slug: "season-2", title: "Season <2>", ...state.article }]
            : [];
        }
        if (sql.startsWith("SELECT * FROM public.news_comments")) {
          const row = state.comments.get(params[0]);
          return row ? [row] : [];
        }
        if (sql.includes("INSERT INTO public.news_comments")) {
          const row = comment({
            id: `c${state.comments.size + 1}`,
            parent_id: params[1],
            author_steam_id: params[2],
            body: params[3],
          });
          state.comments.set(row.id, row);
          return [row];
        }
        if (sql.includes("SET reply_notified_at = now()")) {
          if (state.claimed.has(params[0])) return [];
          state.claimed.add(params[0]);
          return [{ id: params[0] }];
        }
        if (sql.includes("SET reply_notified_at = NULL")) {
          state.claimed.delete(params[0]);
          return [];
        }
        if (sql.includes("FROM public.players")) {
          return [{ name: params[0] === other.steam_id ? other.name : "Ver" }];
        }
        if (sql.includes("DELETE FROM public.news_comment_votes")) {
          const key = `${params[0]}:${params[1]}`;
          return state.votes.delete(key) ? [{ comment_id: params[0] }] : [];
        }
        if (sql.includes("INSERT INTO public.news_comment_votes")) {
          state.votes.add(`${params[0]}:${params[1]}`);
          return [];
        }
        if (sql.includes("SELECT vote_count")) {
          return [{ vote_count: [...state.votes].filter((v) => v.startsWith(`${params[0]}:`)).length }];
        }
        if (sql.includes("SET body = $2")) {
          const row = { ...state.comments.get(params[0])!, body: params[1], edited_at: new Date().toISOString() };
          state.comments.set(row.id, row);
          return [row];
        }
        if (sql.includes("SET deleted_at = now()")) {
          const row = state.comments.get(params[0])!;
          row.deleted_at = new Date().toISOString();
          return [];
        }
        if (sql.includes("SET hidden_at = COALESCE")) {
          const row = { ...state.comments.get(params[0])!, hidden_at: new Date().toISOString(), hidden_by_steam_id: params[1], hidden_reason: params[2] };
          state.comments.set(row.id, row);
          return [row];
        }
        if (sql.includes("SET hidden_at = NULL")) {
          const row = { ...state.comments.get(params[0])!, hidden_at: null, hidden_by_steam_id: null, hidden_reason: null };
          state.comments.set(row.id, row);
          return [row];
        }
        throw new Error(`unexpected sql: ${sql}`);
      }),
    };
    notifications = { notifyPlayers: jest.fn().mockResolvedValue(undefined) };
    const redis = {
      eval: jest.fn(async (_s: string, _k: number, key: string) => {
        const count = (rates.get(key) ?? 0) + 1;
        rates.set(key, count);
        return count;
      }),
    };
    service = new NewsCommentsService(
      { error: jest.fn(), log: jest.fn() } as any,
      postgres as any,
      notifications as any,
      { getConnection: () => redis } as any,
    );
  });

  const post = (user: any, body = "Great news", parent_id: string | null = null) =>
    service.post(user, { article_id: ARTICLE, parent_id, body });

  describe("who may write", () => {
    it("lets Verified Users and above comment", async () => {
      await expect(post(verified)).resolves.toMatchObject({ text: "Great news" });
      await expect(post(streamer)).resolves.toBeTruthy();
      await expect(post(moderator)).resolves.toBeTruthy();
    });

    it("refuses guests and plain users", async () => {
      await expect(post(undefined)).rejects.toThrow(ForbiddenException);
      await expect(post(plainUser)).rejects.toThrow(
        "Only Verified Users can comment and +1",
      );
      await expect(
        service.toggleVote(plainUser, { id: "c1" }),
      ).rejects.toThrow("Only Verified Users can comment and +1");
    });

    it.each(["ban", "website_restriction", "website_chat_mute"])(
      "refuses a player with an active %s",
      async (type) => {
        state.sanctions = [type];
        await expect(post(verified)).rejects.toThrow(
          "Your account cannot comment or vote right now",
        );
        await expect(service.toggleVote(other, { id: "c1" })).rejects.toThrow(
          "Your account cannot comment or vote right now",
        );
      },
    );
  });

  describe("posting", () => {
    it("trims, refuses empty and over-long text", async () => {
      await expect(post(verified, "  hi  ")).resolves.toMatchObject({ text: "hi" });
      await expect(post(verified, "   ")).rejects.toThrow("Write something first");
      await expect(post(verified, "x".repeat(2001))).rejects.toThrow(
        "at most 2000 characters",
      );
    });

    it("says comments are closed after the 7-day window", async () => {
      state.article = { open: false, status: "published" };
      await expect(post(verified)).rejects.toThrow(
        "Comments are closed for this article",
      );
    });

    it("refuses replies to replies and to removed comments", async () => {
      state.comments.set("r1", comment({ id: "r1", parent_id: "c1" }));
      state.comments.set("gone", comment({ id: "gone", hidden_at: "x" }));
      await expect(post(other, "deep", "r1")).rejects.toThrow(
        "Replies can only answer a top-level comment",
      );
      await expect(post(other, "late", "gone")).rejects.toThrow(
        "can no longer be replied to",
      );
    });

    it("rate limits to 3 a minute", async () => {
      for (let i = 0; i < NEWS_COMMENT_RATE_LIMITS.postPerMinute.limit; i++) {
        await post(verified, `c${i}`);
      }
      await expect(post(verified)).rejects.toThrow(
        "You are commenting too fast",
      );
    });

    it("rate limits to 30 a day", async () => {
      rates.set(`news-comments:post:day:${verified.steam_id}`, 30);
      await expect(post(verified)).rejects.toThrow("today's comment limit");
    });
  });

  describe("reply notifications", () => {
    it("notifies the parent comment's author once, escaped and linked", async () => {
      const reply = await post(other, "Agree <script>x</script>", "c1");

      expect(notifications.notifyPlayers).toHaveBeenCalledTimes(1);
      const [type, payload] = notifications.notifyPlayers.mock.calls[0];
      expect(type).toBe("NewsCommentReply");
      expect(payload.steamIds).toEqual([verified.steam_id]);
      expect(payload.entity_id).toBe(`news_comment:season-2:${reply.id}`);
      expect(payload.message).toContain(`href="/news/season-2#comment-${reply.id}"`);
      expect(payload.message).toContain("&lt;b&gt;Bob&lt;/b&gt;");
      expect(payload.message).toContain("Season &lt;2&gt;");
      expect(payload.message).toContain("&lt;script&gt;");
      expect(payload.message).not.toContain("<script>");
    });

    it("does not notify for replying to yourself", async () => {
      await post(verified, "adding to my own comment", "c1");
      expect(notifications.notifyPlayers).not.toHaveBeenCalled();
    });

    it("does not notify for top-level comments", async () => {
      await post(other, "top level");
      expect(notifications.notifyPlayers).not.toHaveBeenCalled();
    });

    it("never notifies twice for the same reply", async () => {
      state.claimed.add("c2");
      await post(other, "retry", "c1");
      expect(notifications.notifyPlayers).not.toHaveBeenCalled();
    });

    it("keeps the reply when the notification fails, and releases the claim", async () => {
      notifications.notifyPlayers.mockRejectedValueOnce(new Error("down"));
      const reply = await post(other, "still saved", "c1");
      expect(state.comments.get(reply.id)?.body).toBe("still saved");
      expect(state.claimed.has(reply.id)).toBe(false);
    });
  });

  describe("+1", () => {
    it("toggles one vote per player", async () => {
      await expect(service.toggleVote(other, { id: "c1" })).resolves.toEqual({
        comment_id: "c1",
        vote_count: 1,
        voted: true,
      });
      await expect(service.toggleVote(other, { id: "c1" })).resolves.toEqual({
        comment_id: "c1",
        vote_count: 0,
        voted: false,
      });
    });

    it("refuses your own comment, removed comments and closed threads", async () => {
      await expect(service.toggleVote(verified, { id: "c1" })).rejects.toThrow(
        "You cannot +1 your own comment",
      );
      state.comments.set("h", comment({ id: "h", hidden_at: "x" }));
      await expect(service.toggleVote(other, { id: "h" })).rejects.toThrow(
        "can no longer be voted on",
      );
      state.article = { open: false, status: "published" };
      await expect(service.toggleVote(other, { id: "c1" })).rejects.toThrow(
        "Comments are closed",
      );
    });

    it("rate limits to 30 a minute", async () => {
      rates.set(`news-comments:vote:min:${other.steam_id}`, 30);
      await expect(service.toggleVote(other, { id: "c1" })).rejects.toThrow(
        "You are voting too fast",
      );
    });
  });

  describe("edit and delete", () => {
    it("edits your own comment within 10 minutes", async () => {
      await expect(
        service.edit(verified, { id: "c1", body: "fixed" }),
      ).resolves.toMatchObject({ text: "fixed" });
    });

    it("refuses edits after 10 minutes and on other players' comments", async () => {
      state.comments.set(
        "old",
        comment({ id: "old", created_at: new Date(Date.now() - 11 * 60_000).toISOString() }),
      );
      await expect(service.edit(verified, { id: "old", body: "x" })).rejects.toThrow(
        "only be edited for 10 minutes",
      );
      await expect(service.edit(other, { id: "c1", body: "x" })).rejects.toThrow(
        "You can only change your own comments",
      );
    });

    it("lets authors delete their own comment, even after the window", async () => {
      state.article = { open: false, status: "published" };
      await expect(service.remove(verified, { id: "c1" })).resolves.toEqual({
        success: true,
      });
      expect(state.comments.get("c1")?.deleted_at).toBeTruthy();
      await expect(service.remove(other, { id: "c1" })).rejects.toThrow(
        "You can only change your own comments",
      );
    });
  });

  describe("staff moderation", () => {
    it("lets moderators and above hide and restore with a reason", async () => {
      const hidden = await service.setHidden(moderator, {
        id: "c1",
        hidden: true,
        reason: "  spam ",
      });
      expect(hidden.hidden_at).toBeTruthy();
      expect(state.comments.get("c1")?.hidden_reason).toBe("spam");
      const restored = await service.setHidden(moderator, { id: "c1", hidden: false });
      expect(restored.hidden_at).toBeNull();
    });

    it("refuses everyone below moderator", async () => {
      for (const user of [verified, streamer, plainUser]) {
        await expect(
          service.setHidden(user, { id: "c1", hidden: true }),
        ).rejects.toThrow("Only staff can hide comments");
      }
      await expect(
        service.setHidden(undefined, { id: "c1", hidden: true }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  it("maps database rule errors to a clear 400", async () => {
    postgres.query.mockImplementationOnce(async () => []); // sanctions
    postgres.query.mockImplementationOnce(async () => [
      { id: ARTICLE, slug: "s", title: "t", status: "published", open: true },
    ]);
    postgres.query.mockImplementationOnce(async () => {
      throw Object.assign(new Error("Comments are closed for this article"), {
        code: "22023",
      });
    });
    await expect(post(verified)).rejects.toThrow(BadRequestException);
  });

  it("escapes HTML", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;",
    );
  });
});
