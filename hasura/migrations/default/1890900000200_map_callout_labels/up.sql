-- DEAFCS-only: a staff-chosen display name for a map callout ("Jungle" for
-- Valve's "Connector", say). 5Stack upstream has none.
--
-- Kept apart from public.map_callouts on purpose. That table is rewritten
-- from the published 5Stack extract on every sync, which prunes names the
-- extract no longer carries; a label here is never touched by a sync, and
-- the callout's original name and boxes are never changed. A label whose
-- callout is gone for now does nothing and comes back with it.
--
-- Read by everyone; written by administrators only (Hasura metadata).
CREATE TABLE IF NOT EXISTS public.map_callout_labels (
    -- Normalised the same way as map_callouts.map_name.
    map_name text NOT NULL,
    -- The callout's original name, exactly as map_callouts stores it.
    name text NOT NULL,
    label text NOT NULL
        CONSTRAINT map_callout_labels_label_check
        CHECK (char_length(label) BETWEEN 1 AND 48 AND label = btrim(label)),
    updated_by bigint
        REFERENCES public.players(steam_id) ON DELETE SET NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (map_name, name)
);

CREATE OR REPLACE FUNCTION public.map_callout_labels_touch()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS map_callout_labels_touch ON public.map_callout_labels;
CREATE TRIGGER map_callout_labels_touch
    BEFORE UPDATE ON public.map_callout_labels
    FOR EACH ROW EXECUTE FUNCTION public.map_callout_labels_touch();
