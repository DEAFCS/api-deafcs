-- Player of the Month (homepage + award history).
--
-- The award itself is an ordinary award: one award_occurrences row per month
-- (source 'manual', calculation_key 'player_of_the_month:YYYY-MM', effective
-- at the first day of the month, UTC) with one award_recipients row. It shows
-- in the winner's award history like every other award and can only be
-- created by the API's staff approval (never automatically).
--
-- The monthly review (calculated candidates, staff decision, audit trail) is
-- kept here. Both tables are written only by the API (Hasura actions
-- calculatePlayerOfTheMonth / approvePlayerOfTheMonth /
-- rejectPlayerOfTheMonth, administrators only) and are not tracked in Hasura.

INSERT INTO public.awards (name, description, tier, system_key, allow_multiple)
VALUES (
    'Player of the Month',
    'Most legitimate completed DEAFCS matches in a calendar month (UTC), reviewed and approved by DEAFCS staff.',
    'special',
    'player_of_the_month',
    -- A player can win again after the 12-month repeat window; each month
    -- is its own occurrence, so this never allows two winners for one month
    -- (calculation_key is unique).
    true
)
ON CONFLICT (system_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.player_of_the_month_reviews (
    -- First day of the award month (UTC).
    month date PRIMARY KEY CHECK (EXTRACT(DAY FROM month) = 1),
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'rejected')),
    -- The rules the candidates were calculated with; kept with the snapshot
    -- so a past month still shows why it was decided the way it was even if
    -- the monthly rules change later.
    rules_version integer NOT NULL,
    rules jsonb NOT NULL DEFAULT '{}'::jsonb,
    candidates jsonb NOT NULL DEFAULT '[]'::jsonb,
    calculated_at timestamptz NOT NULL DEFAULT now(),
    calculated_by_steam_id bigint REFERENCES public.players(steam_id) ON DELETE SET NULL,
    winner_steam_id bigint REFERENCES public.players(steam_id) ON DELETE RESTRICT,
    occurrence_id uuid UNIQUE REFERENCES public.award_occurrences(id) ON DELETE RESTRICT,
    decided_by_steam_id bigint REFERENCES public.players(steam_id) ON DELETE SET NULL,
    decided_at timestamptz,
    decision_note text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT player_of_the_month_reviews_approved_has_award CHECK (
        (status = 'approved') = (winner_steam_id IS NOT NULL AND occurrence_id IS NOT NULL)
    ),
    CONSTRAINT player_of_the_month_reviews_decided CHECK (
        status = 'pending' OR (decided_by_steam_id IS NOT NULL OR decided_at IS NOT NULL)
    )
);

-- Append-only audit trail: every calculation, approval and rejection, with
-- who did it and what they saw.
CREATE TABLE IF NOT EXISTS public.player_of_the_month_review_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    month date NOT NULL REFERENCES public.player_of_the_month_reviews(month) ON DELETE RESTRICT,
    action text NOT NULL CHECK (action IN ('calculated', 'approved', 'rejected')),
    actor_steam_id bigint REFERENCES public.players(steam_id) ON DELETE SET NULL,
    detail jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_player_of_the_month_review_events_month
    ON public.player_of_the_month_review_events (month, created_at);

CREATE OR REPLACE FUNCTION public.tbud_player_of_the_month_review_events_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Player of the Month review events are append-only';
END $$;

DROP TRIGGER IF EXISTS tbud_player_of_the_month_review_events_append_only
    ON public.player_of_the_month_review_events;
CREATE TRIGGER tbud_player_of_the_month_review_events_append_only
    BEFORE UPDATE OR DELETE ON public.player_of_the_month_review_events
    FOR EACH ROW EXECUTE FUNCTION public.tbud_player_of_the_month_review_events_append_only();
