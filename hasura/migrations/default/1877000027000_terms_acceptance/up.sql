-- One row per (player, terms version) they have explicitly accepted.
-- Historical rows are never deleted or overwritten by a version bump --
-- a version bump just means no row exists yet for the new version, so
-- has_accepted_current_terms() goes back to false until they accept again.
--
-- ON DELETE RESTRICT (not cascade): this table is acceptance EVIDENCE, not
-- player-owned preference data -- a hard delete of a players row must not
-- silently erase proof that identity accepted a given Terms version at a
-- given time. Matches award_recipients.player_steam_id (also an evidence/
-- record column, same ON DELETE RESTRICT, no ON UPDATE override since
-- steam_id is immutable in practice).
CREATE TABLE IF NOT EXISTS public.player_terms_acceptances (
    player_steam_id bigint NOT NULL,
    terms_version text NOT NULL,
    accepted_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (player_steam_id, terms_version),
    FOREIGN KEY (player_steam_id) REFERENCES public.players(steam_id) ON DELETE RESTRICT
);

-- Canonical current Terms version. has_accepted_current_terms() treats a
-- missing/blank value as "no version configured" and fails closed (false),
-- never as automatically accepted. ON CONFLICT DO NOTHING so a later admin
-- version bump (updating this row) is never reset by a redeploy.
INSERT INTO public.settings (name, value)
VALUES ('public.terms_version', '2026-08-23')
ON CONFLICT (name) DO NOTHING;
