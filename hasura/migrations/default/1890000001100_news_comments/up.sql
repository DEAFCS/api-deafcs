-- DEAFCS-only: comments under News articles (5Stack upstream has none).
-- Approved by Anders 2026-10-14, see news-comments-plan-2026-10-14.md.
--
-- Writes go through the API's Hasura actions (postNewsComment and friends);
-- no role gets insert/update/delete on these tables. The rules that must
-- hold even if an action is bypassed (7-day window, one reply level, no
-- self-votes, vote counts) live in hasura/triggers/news_comments.sql.
--
-- Deletion is soft: deleted_at (author) and hidden_at (staff) keep the row,
-- so replies keep their place and moderation stays auditable. Rows only go
-- away with their article.

CREATE TABLE IF NOT EXISTS public.news_comments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    article_id uuid NOT NULL
        REFERENCES public.news_articles(id) ON DELETE CASCADE,
    parent_id uuid
        REFERENCES public.news_comments(id) ON DELETE CASCADE,
    author_steam_id bigint NOT NULL
        REFERENCES public.players(steam_id) ON DELETE CASCADE,
    body text NOT NULL
        CONSTRAINT news_comments_body_length
        CHECK (char_length(btrim(body)) BETWEEN 1 AND 2000),
    vote_count integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    edited_at timestamptz,
    deleted_at timestamptz,
    hidden_at timestamptz,
    hidden_by_steam_id bigint
        REFERENCES public.players(steam_id) ON DELETE SET NULL,
    hidden_reason text,
    -- Set once, atomically, when the parent author has been notified of this
    -- reply, so a retried request can never notify twice.
    reply_notified_at timestamptz
);

-- Top-level comments of an article, oldest first (the list order).
CREATE INDEX IF NOT EXISTS news_comments_article_created_idx
    ON public.news_comments (article_id, created_at)
    WHERE parent_id IS NULL;

-- Replies of a comment, oldest first.
CREATE INDEX IF NOT EXISTS news_comments_parent_created_idx
    ON public.news_comments (parent_id, created_at)
    WHERE parent_id IS NOT NULL;

-- A player's own comments (the API's per-player limits).
CREATE INDEX IF NOT EXISTS news_comments_author_created_idx
    ON public.news_comments (author_steam_id, created_at);

CREATE TABLE IF NOT EXISTS public.news_comment_votes (
    comment_id uuid NOT NULL
        REFERENCES public.news_comments(id) ON DELETE CASCADE,
    steam_id bigint NOT NULL
        REFERENCES public.players(steam_id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    -- One +1 per player per comment.
    PRIMARY KEY (comment_id, steam_id)
);

-- "Which of these comments did I +1" lookups.
CREATE INDEX IF NOT EXISTS news_comment_votes_steam_id_idx
    ON public.news_comment_votes (steam_id);

-- Reply notification for the parent comment's author (same pattern as
-- NewsPublished, 1877000006000).
INSERT INTO public.e_notification_types ("value", "description") VALUES
    ('NewsCommentReply', 'Someone replied to your News comment')
ON CONFLICT ("value") DO UPDATE SET "description" = EXCLUDED."description";
