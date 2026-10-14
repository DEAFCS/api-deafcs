import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import Redis from "ioredis";
import { PostgresService } from "src/postgres/postgres.service";
import { RedisManagerService } from "src/redis/redis-manager/redis-manager.service";
import { NotificationsService } from "src/notifications/notifications.service";
import { isRoleAbove } from "src/utilities/isRoleAbove";
import { User } from "../auth/types/User";
import { e_notification_types_enum } from "generated/schema";

// DEAFCS-only: comments under News articles (5Stack has none). Approved by
// Anders 2026-10-14 (news-comments-plan-2026-10-14.md):
// - Verified Users and above may comment, reply and +1.
// - Own comments can be edited for 10 minutes.
// - The parent comment's author is notified of a reply (not their own).
// - A thread is open for 7 days after the article is published, then
//   read-only. Authors can still delete, staff can still hide/restore.
// The database triggers (hasura/triggers/news_comments.sql) enforce the same
// rules; the checks here exist to give players a clear message first.

export const NEWS_COMMENT_MAX_LENGTH = 2000;
export const NEWS_COMMENT_EDIT_MINUTES = 10;
export const NEWS_COMMENT_HIDE_REASON_MAX_LENGTH = 500;

// Per player. Redis is only the limiter; Postgres is the store.
export const NEWS_COMMENT_RATE_LIMITS = {
  postPerMinute: { limit: 3, windowMs: 60_000 },
  postPerDay: { limit: 30, windowMs: 24 * 60 * 60_000 },
  votePerMinute: { limit: 30, windowMs: 60_000 },
};

// Sanctions that block writing (the same ones Website Chat honours).
const BLOCKING_SANCTIONS = ["ban", "website_restriction", "website_chat_mute"];

const NOTIFICATION_SNIPPET_LENGTH = 120;

export interface NewsCommentRow {
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
}

export interface NewsCommentOutput {
  id: string;
  article_id: string;
  parent_id: string | null;
  vote_count: number;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  hidden_at: string | null;
  text: string | null;
}

@Injectable()
export class NewsCommentsService {
  private static readonly RATE_SCRIPT = `
    local count = redis.call('INCR', KEYS[1])
    if count == 1 then
      redis.call('PEXPIRE', KEYS[1], ARGV[1])
    end
    return count
  `;

  private readonly redis: Redis;

  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    private readonly notifications: NotificationsService,
    redisManager: RedisManagerService,
  ) {
    this.redis = redisManager.getConnection();
  }

  public async post(
    user: User | undefined,
    input: { article_id: string; parent_id?: string | null; body: string },
  ): Promise<NewsCommentOutput> {
    const author = await this.assertCanWrite(user);
    const body = this.cleanBody(input.body);

    const article = await this.getArticle(input.article_id);
    if (!article || article.status !== "published") {
      throw new NotFoundException("This article was not found");
    }
    if (!article.open) {
      throw new BadRequestException("Comments are closed for this article");
    }

    let parent: NewsCommentRow | null = null;
    if (input.parent_id) {
      parent = await this.getComment(input.parent_id);
      if (!parent || parent.article_id !== article.id) {
        throw new BadRequestException("That comment was not found");
      }
      if (parent.parent_id) {
        throw new BadRequestException(
          "Replies can only answer a top-level comment",
        );
      }
      if (parent.deleted_at || parent.hidden_at) {
        throw new BadRequestException(
          "This comment can no longer be replied to",
        );
      }
    }

    await this.assertWithinRate(
      `news-comments:post:min:${author.steam_id}`,
      NEWS_COMMENT_RATE_LIMITS.postPerMinute,
      "You are commenting too fast. Please wait a minute.",
    );
    await this.assertWithinRate(
      `news-comments:post:day:${author.steam_id}`,
      NEWS_COMMENT_RATE_LIMITS.postPerDay,
      "You have reached today's comment limit.",
    );

    const [row] = await this.write<NewsCommentRow[]>(
      `INSERT INTO public.news_comments (article_id, parent_id, author_steam_id, body)
       VALUES ($1, $2, $3::bigint, $4)
       RETURNING *`,
      [article.id, parent?.id ?? null, author.steam_id, body],
    );

    if (parent) {
      await this.notifyReply(row, parent, author, article).catch((error) =>
        this.logger.error(
          `could not notify the author of comment ${parent.id} of reply ${row.id}`,
          error,
        ),
      );
    }

    return this.toOutput(row);
  }

  public async edit(
    user: User | undefined,
    input: { id: string; body: string },
  ): Promise<NewsCommentOutput> {
    const author = await this.assertCanWrite(user);
    const body = this.cleanBody(input.body);
    const comment = await this.getOwnComment(author, input.id);

    if (comment.deleted_at || comment.hidden_at) {
      throw new BadRequestException("This comment can no longer be edited");
    }
    const editableUntil =
      new Date(comment.created_at).getTime() +
      NEWS_COMMENT_EDIT_MINUTES * 60_000;
    if (Date.now() > editableUntil) {
      throw new BadRequestException(
        `Comments can only be edited for ${NEWS_COMMENT_EDIT_MINUTES} minutes`,
      );
    }
    if (body === comment.body) {
      return this.toOutput(comment);
    }

    const [row] = await this.write<NewsCommentRow[]>(
      `UPDATE public.news_comments SET body = $2 WHERE id = $1 RETURNING *`,
      [comment.id, body],
    );
    return this.toOutput(row);
  }

  // Authors may always remove their own comment, even after the thread
  // closed or while sanctioned: removing never adds anything.
  public async remove(
    user: User | undefined,
    input: { id: string },
  ): Promise<{ success: boolean }> {
    const author = this.assertSignedIn(user);
    const comment = await this.getOwnComment(author, input.id);
    if (!comment.deleted_at) {
      await this.write(
        `UPDATE public.news_comments SET deleted_at = now()
          WHERE id = $1 AND deleted_at IS NULL`,
        [comment.id],
      );
    }
    return { success: true };
  }

  public async toggleVote(
    user: User | undefined,
    input: { id: string },
  ): Promise<{ comment_id: string; vote_count: number; voted: boolean }> {
    const voter = await this.assertCanWrite(user);
    const comment = await this.getComment(input.id);
    if (!comment) {
      throw new NotFoundException("That comment was not found");
    }
    if (String(comment.author_steam_id) === String(voter.steam_id)) {
      throw new BadRequestException("You cannot +1 your own comment");
    }
    if (comment.deleted_at || comment.hidden_at) {
      throw new BadRequestException("This comment can no longer be voted on");
    }
    const article = await this.getArticle(comment.article_id);
    if (!article?.open) {
      throw new BadRequestException("Comments are closed for this article");
    }

    await this.assertWithinRate(
      `news-comments:vote:min:${voter.steam_id}`,
      NEWS_COMMENT_RATE_LIMITS.votePerMinute,
      "You are voting too fast. Please wait a minute.",
    );

    const removed = await this.write<Array<{ comment_id: string }>>(
      `DELETE FROM public.news_comment_votes
        WHERE comment_id = $1 AND steam_id = $2::bigint
        RETURNING comment_id`,
      [comment.id, voter.steam_id],
    );
    let voted = false;
    if (removed.length === 0) {
      // ON CONFLICT: a double click that raced the first one stays one vote.
      await this.write(
        `INSERT INTO public.news_comment_votes (comment_id, steam_id)
         VALUES ($1, $2::bigint)
         ON CONFLICT (comment_id, steam_id) DO NOTHING`,
        [comment.id, voter.steam_id],
      );
      voted = true;
    }

    const [{ vote_count }] = await this.postgres.query<
      Array<{ vote_count: number }>
    >(`SELECT vote_count FROM public.news_comments WHERE id = $1`, [
      comment.id,
    ]);
    return { comment_id: comment.id, vote_count: Number(vote_count), voted };
  }

  public async setHidden(
    user: User | undefined,
    input: { id: string; hidden: boolean; reason?: string | null },
  ): Promise<NewsCommentOutput> {
    const moderator = this.assertSignedIn(user);
    if (!isRoleAbove(moderator.role, "moderator")) {
      throw new ForbiddenException("Only staff can hide comments");
    }
    const comment = await this.getComment(input.id);
    if (!comment) {
      throw new NotFoundException("That comment was not found");
    }

    const reason =
      (input.reason ?? "").trim().slice(0, NEWS_COMMENT_HIDE_REASON_MAX_LENGTH) ||
      null;
    const [row] = input.hidden
      ? await this.write<NewsCommentRow[]>(
          `UPDATE public.news_comments
              SET hidden_at = COALESCE(hidden_at, now()),
                  hidden_by_steam_id = $2::bigint,
                  hidden_reason = $3
            WHERE id = $1
            RETURNING *`,
          [comment.id, moderator.steam_id, reason],
        )
      : await this.write<NewsCommentRow[]>(
          `UPDATE public.news_comments
              SET hidden_at = NULL, hidden_by_steam_id = NULL, hidden_reason = NULL
            WHERE id = $1
            RETURNING *`,
          [comment.id],
        );

    this.logger.log(
      `news comment ${comment.id} ${input.hidden ? "hidden" : "restored"} by ${moderator.steam_id}`,
    );
    return this.toOutput(row);
  }

  // One notification per reply: reply_notified_at is claimed atomically, so a
  // retry (or a second API instance) can never send it twice. No notification
  // for answering yourself. Push delivery and the bell honour the player's
  // existing preferences ("news_replies" push category, in-app toggle).
  private async notifyReply(
    reply: NewsCommentRow,
    parent: NewsCommentRow,
    replier: User,
    article: { slug: string; title: string },
  ): Promise<void> {
    if (String(parent.author_steam_id) === String(reply.author_steam_id)) {
      return;
    }

    const claimed = await this.postgres.query<Array<{ id: string }>>(
      `UPDATE public.news_comments SET reply_notified_at = now()
        WHERE id = $1 AND reply_notified_at IS NULL
        RETURNING id`,
      [reply.id],
    );
    if (claimed.length === 0) {
      return;
    }

    const name = await this.playerName(replier);
    const snippet =
      reply.body.length > NOTIFICATION_SNIPPET_LENGTH
        ? `${reply.body.slice(0, NOTIFICATION_SNIPPET_LENGTH - 1)}…`
        : reply.body;
    const link = `/news/${encodeURIComponent(article.slug)}#comment-${reply.id}`;

    try {
      await this.notifications.notifyPlayers(
        "NewsCommentReply" as e_notification_types_enum,
        {
          title: "New reply to your comment",
          // The bell renders this as HTML: everything player-written is
          // escaped.
          message:
            `<b>${escapeHtml(name)}</b> replied on ` +
            `<a href="${escapeHtml(link)}">${escapeHtml(article.title)}</a>: ` +
            `${escapeHtml(snippet)}`,
          role: "user",
          entity_id: `news_comment:${article.slug}:${reply.id}`,
          steamIds: [String(parent.author_steam_id)],
        },
      );
    } catch (error) {
      await this.postgres.query(
        `UPDATE public.news_comments SET reply_notified_at = NULL WHERE id = $1`,
        [reply.id],
      );
      throw error;
    }
  }

  private assertSignedIn(user?: User): User {
    if (!user) {
      throw new ForbiddenException("Sign in to take part in the comments");
    }
    return user;
  }

  private async assertCanWrite(user?: User): Promise<User> {
    const player = this.assertSignedIn(user);
    if (!isRoleAbove(player.role, "verified_user")) {
      throw new ForbiddenException("Only Verified Users can comment and +1");
    }

    const [sanction] = await this.postgres.query<Array<{ type: string }>>(
      `SELECT type
         FROM public.player_sanctions
        WHERE player_steam_id = $1::bigint
          AND type = ANY($2::text[])
          AND deleted_at IS NULL
          AND (remove_sanction_date IS NULL OR remove_sanction_date > now())
        LIMIT 1`,
      [player.steam_id, BLOCKING_SANCTIONS],
    );
    if (sanction) {
      throw new ForbiddenException(
        "Your account cannot comment or vote right now",
      );
    }
    return player;
  }

  private async assertWithinRate(
    key: string,
    { limit, windowMs }: { limit: number; windowMs: number },
    message: string,
  ): Promise<void> {
    const count = await this.redis.eval(
      NewsCommentsService.RATE_SCRIPT,
      1,
      key,
      windowMs,
    );
    if (Number(count) > limit) {
      throw new BadRequestException(message);
    }
  }

  private cleanBody(body: string | null | undefined): string {
    const text = (body ?? "").replace(/\r\n?/g, "\n").trim();
    if (!text) {
      throw new BadRequestException("Write something first");
    }
    if (text.length > NEWS_COMMENT_MAX_LENGTH) {
      throw new BadRequestException(
        `Comments can be at most ${NEWS_COMMENT_MAX_LENGTH} characters`,
      );
    }
    return text;
  }

  private async getArticle(id: string): Promise<{
    id: string;
    slug: string;
    title: string;
    status: string;
    open: boolean;
  } | null> {
    const [row] = await this.postgres.query<
      Array<{
        id: string;
        slug: string;
        title: string;
        status: string;
        open: boolean;
      }>
    >(
      `SELECT id, slug, title, status, public.news_comments_open(id) AS open
         FROM public.news_articles
        WHERE id = $1`,
      [id],
    );
    return row ?? null;
  }

  private async getComment(id: string): Promise<NewsCommentRow | null> {
    const [row] = await this.postgres.query<NewsCommentRow[]>(
      `SELECT * FROM public.news_comments WHERE id = $1`,
      [id],
    );
    return row ?? null;
  }

  private async getOwnComment(
    author: User,
    id: string,
  ): Promise<NewsCommentRow> {
    const comment = await this.getComment(id);
    if (!comment) {
      throw new NotFoundException("That comment was not found");
    }
    if (String(comment.author_steam_id) !== String(author.steam_id)) {
      throw new ForbiddenException("You can only change your own comments");
    }
    return comment;
  }

  private async playerName(player: User): Promise<string> {
    const [row] = await this.postgres.query<Array<{ name: string }>>(
      `SELECT name FROM public.players WHERE steam_id = $1::bigint`,
      [player.steam_id],
    );
    return row?.name || player.name || "A player";
  }

  // Trigger rules raise SQLSTATE 22023 with a player-facing message; anything
  // else is a real error.
  private async write<T = unknown>(
    sql: string,
    params: Parameters<PostgresService["query"]>[1],
  ): Promise<T> {
    try {
      return await this.postgres.query<T>(sql, params);
    } catch (error) {
      if (error?.code === "22023") {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }

  private toOutput(row: NewsCommentRow): NewsCommentOutput {
    return {
      id: row.id,
      article_id: row.article_id,
      parent_id: row.parent_id,
      vote_count: Number(row.vote_count),
      created_at: new Date(row.created_at).toISOString(),
      edited_at: row.edited_at ? new Date(row.edited_at).toISOString() : null,
      deleted_at: row.deleted_at
        ? new Date(row.deleted_at).toISOString()
        : null,
      hidden_at: row.hidden_at ? new Date(row.hidden_at).toISOString() : null,
      text: row.deleted_at ? null : row.body,
    };
  }
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
