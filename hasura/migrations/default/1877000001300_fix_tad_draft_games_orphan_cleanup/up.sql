-- tad_draft_games (AFTER DELETE on draft_games) used to run an unconditional
-- `DELETE FROM match_options WHERE id = OLD.match_options_id`. This fires
-- via matches' own BEFORE DELETE trigger (tbd_matches -> deletes the linked
-- draft_games row -> fires this trigger) *before* the owning matches row is
-- actually removed, so matches.match_options_id still references that same
-- match_options row at that point -- ON DELETE RESTRICT on
-- matches_match_options_id_fkey always rejected it. Result: deleting or
-- canceling any draft game with a linked match always failed with
-- "Foreign key violation ... matches_match_options_id_fkey".
--
-- cleanup_orphaned_match_options() (already used by tad_matches for the same
-- job) only deletes match_options once nothing references it anymore, so
-- it's safe regardless of trigger ordering.
CREATE OR REPLACE FUNCTION public.tad_draft_games() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM cleanup_orphaned_match_options(OLD.match_options_id);
    RETURN OLD;
END;
$$;
