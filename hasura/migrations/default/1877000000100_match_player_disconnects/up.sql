-- One row per disconnect. reconnected_at stays NULL while the player is
-- still offline. A player's cumulative, non-resetting disconnect budget for
-- a match is SUM(COALESCE(reconnected_at, now()) - disconnected_at) across
-- all their rows for that match_id.
CREATE TABLE IF NOT EXISTS public.match_player_disconnects (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    match_id uuid NOT NULL,
    steam_id bigint NOT NULL,
    disconnected_at timestamptz NOT NULL DEFAULT now(),
    reconnected_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id),
    FOREIGN KEY (match_id) REFERENCES public.matches(id) ON UPDATE cascade ON DELETE cascade,
    FOREIGN KEY (steam_id) REFERENCES public.players(steam_id) ON UPDATE cascade ON DELETE cascade
);

CREATE INDEX IF NOT EXISTS idx_match_player_disconnects_lookup
    ON public.match_player_disconnects (match_id, steam_id);

-- Fast lookup of "is this player currently disconnected" without scanning history.
CREATE UNIQUE INDEX IF NOT EXISTS idx_match_player_disconnects_open
    ON public.match_player_disconnects (match_id, steam_id)
    WHERE reconnected_at IS NULL;
