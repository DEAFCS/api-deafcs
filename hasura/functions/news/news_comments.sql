-- DEAFCS-only: News comments (see migration 1890000001100_news_comments).

-- Comments, replies and +1s are open for the first 7 days after an article
-- is published (Anders, 2026-10-14). After that the thread is read-only.
CREATE OR REPLACE FUNCTION public.news_comments_open(article_id uuid)
RETURNS boolean
LANGUAGE sql STABLE
AS $$
    SELECT EXISTS (
        SELECT 1
          FROM public.news_articles a
         WHERE a.id = news_comments_open.article_id
           AND a.status = 'published'
           AND a.published_at IS NOT NULL
           AND now() < a.published_at + interval '7 days'
    );
$$;

-- What a reader sees as the comment text (Hasura computed field `text`).
-- A comment the author deleted shows nothing to anyone. A comment staff hid
-- shows nothing to readers, but its text to staff (moderator and above), so
-- they can review or restore it.
CREATE OR REPLACE FUNCTION public.news_comment_visible_body(
    comment public.news_comments,
    hasura_session json
)
RETURNS text
LANGUAGE sql STABLE
AS $$
    SELECT CASE
        WHEN comment.deleted_at IS NOT NULL THEN NULL
        WHEN comment.hidden_at IS NOT NULL
             AND COALESCE(hasura_session ->> 'x-hasura-role', '') NOT IN (
                 'moderator', 'match_organizer', 'tournament_organizer',
                 'administrator', 'admin'
             ) THEN NULL
        ELSE comment.body
    END;
$$;
