-- DEAFCS-only: News comment rules that hold no matter how a row is written
-- (see migration 1890000001100_news_comments). The API checks the same
-- things first to give players a clear message; these are the backstop.

-- New comments and replies: only while the article is open (published, first
-- 7 days), and replies go one level deep under a comment of the same article.
CREATE OR REPLACE FUNCTION public.tbi_news_comments()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    parent public.news_comments;
BEGIN
    IF NOT public.news_comments_open(NEW.article_id) THEN
        RAISE EXCEPTION 'Comments are closed for this article'
            USING ERRCODE = '22023';
    END IF;

    IF NEW.parent_id IS NOT NULL THEN
        SELECT * INTO parent
          FROM public.news_comments
         WHERE id = NEW.parent_id;

        IF parent.id IS NULL OR parent.article_id <> NEW.article_id THEN
            RAISE EXCEPTION 'Reply must belong to a comment on the same article'
                USING ERRCODE = '22023';
        END IF;

        IF parent.parent_id IS NOT NULL THEN
            RAISE EXCEPTION 'Replies can only answer a top-level comment'
                USING ERRCODE = '22023';
        END IF;

        IF parent.deleted_at IS NOT NULL OR parent.hidden_at IS NOT NULL THEN
            RAISE EXCEPTION 'This comment can no longer be replied to'
                USING ERRCODE = '22023';
        END IF;
    END IF;

    NEW.body := btrim(NEW.body);
    NEW.vote_count := 0;
    NEW.created_at := now();
    NEW.edited_at := NULL;
    NEW.deleted_at := NULL;
    NEW.hidden_at := NULL;
    NEW.hidden_by_steam_id := NULL;
    NEW.hidden_reason := NULL;
    NEW.reply_notified_at := NULL;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbi_news_comments ON public.news_comments;
CREATE TRIGGER tbi_news_comments
    BEFORE INSERT ON public.news_comments
    FOR EACH ROW
    EXECUTE FUNCTION public.tbi_news_comments();

-- Edits: the text can change only within 10 minutes of posting, and never on
-- a deleted or hidden comment. The thread and author never move. Deleting,
-- hiding and restoring are not edits and are allowed at any time.
CREATE OR REPLACE FUNCTION public.tbu_news_comments()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.article_id IS DISTINCT FROM OLD.article_id
       OR NEW.parent_id IS DISTINCT FROM OLD.parent_id
       OR NEW.author_steam_id IS DISTINCT FROM OLD.author_steam_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'A comment cannot be moved'
            USING ERRCODE = '22023';
    END IF;

    IF NEW.body IS DISTINCT FROM OLD.body THEN
        IF OLD.deleted_at IS NOT NULL OR OLD.hidden_at IS NOT NULL THEN
            RAISE EXCEPTION 'This comment can no longer be edited'
                USING ERRCODE = '22023';
        END IF;
        IF now() > OLD.created_at + interval '10 minutes' THEN
            RAISE EXCEPTION 'Comments can only be edited for 10 minutes'
                USING ERRCODE = '22023';
        END IF;
        NEW.body := btrim(NEW.body);
        NEW.edited_at := now();
    END IF;

    -- An author's delete is final.
    IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL THEN
        RAISE EXCEPTION 'A deleted comment cannot be restored'
            USING ERRCODE = '22023';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbu_news_comments ON public.news_comments;
CREATE TRIGGER tbu_news_comments
    BEFORE UPDATE ON public.news_comments
    FOR EACH ROW
    EXECUTE FUNCTION public.tbu_news_comments();

-- +1: not on your own comment, not on a deleted or hidden one, and only while
-- the article is open.
CREATE OR REPLACE FUNCTION public.tbi_news_comment_votes()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    comment public.news_comments;
BEGIN
    SELECT * INTO comment
      FROM public.news_comments
     WHERE id = NEW.comment_id;

    IF comment.author_steam_id = NEW.steam_id THEN
        RAISE EXCEPTION 'You cannot +1 your own comment'
            USING ERRCODE = '22023';
    END IF;

    IF comment.deleted_at IS NOT NULL OR comment.hidden_at IS NOT NULL THEN
        RAISE EXCEPTION 'This comment can no longer be voted on'
            USING ERRCODE = '22023';
    END IF;

    IF NOT public.news_comments_open(comment.article_id) THEN
        RAISE EXCEPTION 'Comments are closed for this article'
            USING ERRCODE = '22023';
    END IF;

    NEW.created_at := now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbi_news_comment_votes ON public.news_comment_votes;
CREATE TRIGGER tbi_news_comment_votes
    BEFORE INSERT ON public.news_comment_votes
    FOR EACH ROW
    EXECUTE FUNCTION public.tbi_news_comment_votes();

-- Taking a +1 back is locked with the thread too. Rows removed by a cascade
-- (the comment, its article or the player is deleted) are not a player's
-- action and always go through: those arrive from inside the foreign key's
-- own trigger, so pg_trigger_depth() is above 1.
CREATE OR REPLACE FUNCTION public.tbd_news_comment_votes()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
DECLARE
    article uuid;
BEGIN
    IF pg_trigger_depth() > 1 THEN
        RETURN OLD;
    END IF;

    SELECT article_id INTO article
      FROM public.news_comments
     WHERE id = OLD.comment_id;

    IF article IS NOT NULL AND NOT public.news_comments_open(article) THEN
        RAISE EXCEPTION 'Comments are closed for this article'
            USING ERRCODE = '22023';
    END IF;

    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS tbd_news_comment_votes ON public.news_comment_votes;
CREATE TRIGGER tbd_news_comment_votes
    BEFORE DELETE ON public.news_comment_votes
    FOR EACH ROW
    EXECUTE FUNCTION public.tbd_news_comment_votes();

-- Keep news_comments.vote_count in step, so listing never counts rows.
CREATE OR REPLACE FUNCTION public.tai_news_comment_votes()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    UPDATE public.news_comments
       SET vote_count = vote_count + 1
     WHERE id = NEW.comment_id;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tai_news_comment_votes ON public.news_comment_votes;
CREATE TRIGGER tai_news_comment_votes
    AFTER INSERT ON public.news_comment_votes
    FOR EACH ROW
    EXECUTE FUNCTION public.tai_news_comment_votes();

CREATE OR REPLACE FUNCTION public.tad_news_comment_votes()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    UPDATE public.news_comments
       SET vote_count = GREATEST(vote_count - 1, 0)
     WHERE id = OLD.comment_id;
    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS tad_news_comment_votes ON public.news_comment_votes;
CREATE TRIGGER tad_news_comment_votes
    AFTER DELETE ON public.news_comment_votes
    FOR EACH ROW
    EXECUTE FUNCTION public.tad_news_comment_votes();
