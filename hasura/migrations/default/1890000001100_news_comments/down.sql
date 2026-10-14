-- The computed-field function takes a news_comments row, so it goes first.
DROP FUNCTION IF EXISTS public.news_comment_visible_body(public.news_comments, json);
DROP TABLE IF EXISTS public.news_comment_votes;
DROP TABLE IF EXISTS public.news_comments;
DROP FUNCTION IF EXISTS public.tbi_news_comments();
DROP FUNCTION IF EXISTS public.tbu_news_comments();
DROP FUNCTION IF EXISTS public.tbi_news_comment_votes();
DROP FUNCTION IF EXISTS public.tbd_news_comment_votes();
DROP FUNCTION IF EXISTS public.tai_news_comment_votes();
DROP FUNCTION IF EXISTS public.tad_news_comment_votes();
DROP FUNCTION IF EXISTS public.news_comments_open(uuid);
DELETE FROM public.notifications WHERE type = 'NewsCommentReply';
DELETE FROM public.e_notification_types WHERE value = 'NewsCommentReply';

-- The boot loader (HasuraService.apply) skips a functions/triggers file whose
-- stored digest is unchanged, so after this rollback a later forward deploy
-- would recreate the tables but not the functions and triggers. Clear their
-- digests so the next boot re-applies them (same pattern as
-- 1870000000200_events). No-op before migration_hashes exists.
DO $$
BEGIN
  IF to_regclass('migration_hashes.hashes') IS NOT NULL THEN
    DELETE FROM migration_hashes.hashes
    WHERE name IN (
      'hasura/functions/news/news_comments',
      'hasura/triggers/news_comments'
    );
  END IF;
END $$;
