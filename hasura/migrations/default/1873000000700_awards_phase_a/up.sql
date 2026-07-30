CREATE TABLE IF NOT EXISTS public.e_award_tiers (
    value text NOT NULL PRIMARY KEY,
    description text NOT NULL
);

INSERT INTO public.e_award_tiers (value, description) VALUES
    ('mvp', 'Most valuable player'),
    ('gold', 'First place'),
    ('silver', 'Second place'),
    ('bronze', 'Third place'),
    ('special', 'Standalone award')
ON CONFLICT (value) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.e_award_sources (
    value text NOT NULL PRIMARY KEY,
    description text NOT NULL
);

INSERT INTO public.e_award_sources (value, description) VALUES
    ('tournament', 'Calculated from a tournament placement'),
    ('manual', 'Granted by hand')
ON CONFLICT (value) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.awards (
    id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    name text NOT NULL,
    description text,
    tier text NOT NULL DEFAULT 'special'
        REFERENCES public.e_award_tiers(value),
    silhouette int CHECK (silhouette IS NULL OR (silhouette >= 0 AND silhouette <= 4)),
    image_url text,
    system_key text UNIQUE,
    allow_multiple boolean NOT NULL DEFAULT false,
    created_by_steam_id bigint REFERENCES public.players(steam_id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.awards (name, description, tier, system_key, allow_multiple) VALUES
    ('Tournament MVP', 'Best performer on the winning roster', 'mvp', 'tournament_mvp', true),
    ('Tournament Champion', 'Won the tournament', 'gold', 'tournament_gold', true),
    ('Tournament Runner-Up', 'Finished second', 'silver', 'tournament_silver', true),
    ('Tournament Third Place', 'Finished third', 'bronze', 'tournament_bronze', true)
ON CONFLICT (system_key) DO NOTHING;

-- The boot phases that re-create functions/triggers run AFTER migrations, so a
-- trigger left bound to the old name would fire against a table that no longer
-- exists and break every tournament UPDATE in the window between the two.
DROP TRIGGER IF EXISTS tau_tournaments_trophies ON public.tournaments;
DROP FUNCTION IF EXISTS public.tau_tournaments_trophies();
DROP FUNCTION IF EXISTS public.calculate_tournament_trophies(uuid);
DROP FUNCTION IF EXISTS public.recalculate_tournament_trophies(uuid);
DROP FUNCTION IF EXISTS public._leaderboard_trophies(INT, TEXT, UUID);

DO $$
BEGIN
    IF to_regclass('public.tournament_trophies') IS NOT NULL
       AND to_regclass('public.award_recipients') IS NULL THEN
        ALTER TABLE public.tournament_trophies RENAME TO award_recipients;
    END IF;

    IF to_regclass('public.tournament_trophy_configs') IS NOT NULL
       AND to_regclass('public.tournament_awards') IS NULL THEN
        ALTER TABLE public.tournament_trophy_configs RENAME TO tournament_awards;
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'tournaments'
          AND column_name = 'trophies_enabled'
    ) THEN
        ALTER TABLE public.tournaments RENAME COLUMN trophies_enabled TO awards_enabled;
    END IF;
END $$;

ALTER TABLE public.tournaments
    ADD COLUMN IF NOT EXISTS awards_enabled boolean NOT NULL DEFAULT true;

ALTER TABLE public.tournament_awards
    ADD COLUMN IF NOT EXISTS award_id uuid REFERENCES public.awards(id) ON DELETE SET NULL;

ALTER TABLE public.award_recipients
    ADD COLUMN IF NOT EXISTS award_id uuid REFERENCES public.awards(id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS source text REFERENCES public.e_award_sources(value),
    ADD COLUMN IF NOT EXISTS awarded_by_steam_id bigint REFERENCES public.players(steam_id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS note text;

UPDATE public.award_recipients recipient
   SET award_id = award.id
  FROM public.awards award
 WHERE recipient.award_id IS NULL
   AND award.system_key = CASE recipient.placement
        WHEN 0 THEN 'tournament_mvp'
        WHEN 1 THEN 'tournament_gold'
        WHEN 2 THEN 'tournament_silver'
        WHEN 3 THEN 'tournament_bronze'
   END;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'award_recipients'
          AND column_name = 'manual'
    ) THEN
        UPDATE public.award_recipients
           SET source = CASE WHEN manual THEN 'manual' ELSE 'tournament' END
         WHERE source IS NULL;

        ALTER TABLE public.award_recipients DROP COLUMN manual;
    END IF;
END $$;

UPDATE public.award_recipients SET source = 'tournament' WHERE source IS NULL;

ALTER TABLE public.award_recipients
    ALTER COLUMN award_id SET NOT NULL,
    ALTER COLUMN source SET NOT NULL,
    ALTER COLUMN source SET DEFAULT 'manual',
    ALTER COLUMN tournament_id DROP NOT NULL,
    ALTER COLUMN tournament_team_id DROP NOT NULL,
    ALTER COLUMN placement DROP NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.award_recipients'::regclass
          AND conname = 'award_recipients_tournament_team_requires_tournament_check'
    ) THEN
        ALTER TABLE public.award_recipients
            ADD CONSTRAINT award_recipients_tournament_team_requires_tournament_check
            CHECK (tournament_team_id IS NULL OR tournament_id IS NOT NULL);
    END IF;
END $$;

DO $$
DECLARE
    v_rename record;
BEGIN
    FOR v_rename IN
        SELECT * FROM (VALUES
            ('tournament_trophies_one_recipient_check', 'award_recipients_one_recipient_check'),
            ('tournament_trophies_mvp_requires_player_check', 'award_recipients_mvp_requires_player_check'),
            ('tournament_trophies_pkey', 'award_recipients_pkey'),
            ('tournament_trophies_placement_check', 'award_recipients_placement_check'),
            ('tournament_trophy_configs_pkey', 'tournament_awards_pkey'),
            ('tournament_trophy_configs_placement_check', 'tournament_awards_placement_check'),
            ('tournament_trophy_configs_silhouette_check', 'tournament_awards_silhouette_check'),
            ('tournament_trophy_configs_tournament_id_placement_key', 'tournament_awards_tournament_id_placement_key')
        ) AS t(old_name, new_name)
    LOOP
        IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = v_rename.old_name)
           AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = v_rename.new_name) THEN
            EXECUTE format(
                'ALTER TABLE public.%I RENAME CONSTRAINT %I TO %I',
                CASE WHEN v_rename.old_name LIKE 'tournament_trophy_configs%'
                     THEN 'tournament_awards' ELSE 'award_recipients' END,
                v_rename.old_name, v_rename.new_name);
        END IF;
    END LOOP;

    FOR v_rename IN
        SELECT * FROM (VALUES
            ('idx_tournament_trophies_player', 'idx_award_recipients_player'),
            ('idx_tournament_trophies_tournament', 'idx_award_recipients_tournament'),
            ('idx_tournament_trophies_team', 'idx_award_recipients_team'),
            ('tournament_trophies_player_recipient_key', 'award_recipients_player_recipient_key'),
            ('tournament_trophies_team_recipient_key', 'award_recipients_team_recipient_key'),
            ('idx_tournament_trophy_configs_tournament', 'idx_tournament_awards_tournament')
        ) AS t(old_name, new_name)
    LOOP
        IF to_regclass('public.' || v_rename.old_name) IS NOT NULL
           AND to_regclass('public.' || v_rename.new_name) IS NULL THEN
            EXECUTE format('ALTER INDEX public.%I RENAME TO %I', v_rename.old_name, v_rename.new_name);
        END IF;
    END LOOP;
END $$;

-- Placement-less awards have no tournament, so the MVP guard must not collapse
-- them onto a single NULL bucket.
DROP INDEX IF EXISTS public.tournament_trophies_one_mvp_per_tournament;
CREATE UNIQUE INDEX IF NOT EXISTS award_recipients_one_mvp_per_tournament
    ON public.award_recipients(tournament_id)
    WHERE placement = 0 AND tournament_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_award_recipients_award
    ON public.award_recipients(award_id);
CREATE INDEX IF NOT EXISTS idx_award_recipients_source
    ON public.award_recipients(tournament_id, source);

ALTER TABLE public.awards
    ADD COLUMN IF NOT EXISTS tournament_id uuid
        REFERENCES public.tournaments(id) ON DELETE SET NULL;

-- SET NULL, not CASCADE: deleting a tournament must not take the award and
-- every grant hanging off it with it.
CREATE INDEX IF NOT EXISTS idx_awards_tournament
    ON public.awards(tournament_id)
    WHERE tournament_id IS NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.awards'::regclass
          AND conname = 'awards_system_award_is_shared_check'
    ) THEN
        ALTER TABLE public.awards
            ADD CONSTRAINT awards_system_award_is_shared_check
            CHECK (system_key IS NULL OR tournament_id IS NULL);
    END IF;
END $$;

-- There is no `leagues` table (the platform runs one global league), so the
-- league-shaped scope hangs off league_seasons.
ALTER TABLE public.awards
    ADD COLUMN IF NOT EXISTS event_id uuid
        REFERENCES public.events(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS season_id uuid
        REFERENCES public.seasons(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS league_season_id uuid
        REFERENCES public.league_seasons(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_awards_event
    ON public.awards(event_id) WHERE event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_awards_season
    ON public.awards(season_id) WHERE season_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_awards_league_season
    ON public.awards(league_season_id) WHERE league_season_id IS NOT NULL;

-- Superseded by the all-scopes check below.
ALTER TABLE public.awards
    DROP CONSTRAINT IF EXISTS awards_system_award_is_shared_check;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.awards'::regclass
          AND conname = 'awards_single_scope_check'
    ) THEN
        ALTER TABLE public.awards
            ADD CONSTRAINT awards_single_scope_check
            CHECK (
                (CASE WHEN tournament_id IS NULL THEN 0 ELSE 1 END) +
                (CASE WHEN event_id IS NULL THEN 0 ELSE 1 END) +
                (CASE WHEN season_id IS NULL THEN 0 ELSE 1 END) +
                (CASE WHEN league_season_id IS NULL THEN 0 ELSE 1 END)
                <= CASE WHEN system_key IS NULL THEN 1 ELSE 0 END
            );
    END IF;
END $$;

ALTER TABLE public.award_recipients
    ADD COLUMN IF NOT EXISTS season_id uuid
        REFERENCES public.seasons(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_award_recipients_season
    ON public.award_recipients(season_id, source)
    WHERE season_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS award_recipients_season_player_key
    ON public.award_recipients(season_id, player_steam_id, placement)
    WHERE season_id IS NOT NULL AND player_steam_id IS NOT NULL;

ALTER TABLE public.award_recipients
    ADD COLUMN IF NOT EXISTS event_id uuid
        REFERENCES public.events(id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS league_season_id uuid
        REFERENCES public.league_seasons(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_award_recipients_event
    ON public.award_recipients(event_id, source) WHERE event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_award_recipients_league_season
    ON public.award_recipients(league_season_id, source)
    WHERE league_season_id IS NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.award_recipients'::regclass
          AND conname = 'award_recipients_single_scope_check'
    ) THEN
        ALTER TABLE public.award_recipients
            ADD CONSTRAINT award_recipients_single_scope_check
            CHECK (
                (CASE WHEN tournament_id IS NULL THEN 0 ELSE 1 END) +
                (CASE WHEN season_id IS NULL THEN 0 ELSE 1 END) +
                (CASE WHEN event_id IS NULL THEN 0 ELSE 1 END) +
                (CASE WHEN league_season_id IS NULL THEN 0 ELSE 1 END) <= 1
            );
    END IF;
END $$;

INSERT INTO public.e_award_sources (value, description) VALUES
    ('season', 'Calculated from a season standing')
ON CONFLICT (value) DO NOTHING;

INSERT INTO public.awards (name, description, tier, system_key, allow_multiple) VALUES
    ('Season MVP', 'Highest impact across the season', 'mvp', 'season_mvp', true),
    ('Season Champion', 'Finished the season top of the ladder', 'gold', 'season_gold', true),
    ('Season Runner-Up', 'Finished the season second', 'silver', 'season_silver', true),
    ('Season Third Place', 'Finished the season third', 'bronze', 'season_bronze', true)
ON CONFLICT (system_key) DO NOTHING;


-- Phase A normalized occurrence model (DEAFCS extension).
ALTER TABLE public.e_award_sources DROP CONSTRAINT IF EXISTS e_award_sources_pkey CASCADE;
ALTER TABLE public.e_award_sources ADD PRIMARY KEY (value);
INSERT INTO public.e_award_sources (value, description) VALUES
  ('tournament_calculated', 'Calculated from a tournament result'),
  ('elo_season_calculated', 'Reserved for calculated matchmaking ELO season awards'),
  ('league_calculated', 'Reserved for calculated league awards'),
  ('migration', 'Converted from legacy trophy history')
ON CONFLICT (value) DO NOTHING;

ALTER TABLE public.awards
  ADD COLUMN IF NOT EXISTS elo_season_id uuid REFERENCES public.seasons(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS league_season_division_id uuid REFERENCES public.league_season_divisions(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS archived_by bigint REFERENCES public.players(steam_id) ON DELETE SET NULL;
ALTER TABLE public.awards DROP COLUMN IF EXISTS season_id;
ALTER TABLE public.awards DROP CONSTRAINT IF EXISTS awards_single_scope_check;
ALTER TABLE public.awards ADD CONSTRAINT awards_single_scope_check CHECK (
  num_nonnulls(tournament_id, event_id, elo_season_id, league_season_id) <= 1
  AND (system_key IS NULL OR num_nonnulls(tournament_id, event_id, elo_season_id, league_season_id) = 0)
);

ALTER TABLE public.award_recipients RENAME TO legacy_award_recipients_phase_a;
ALTER TABLE public.legacy_award_recipients_phase_a
  DROP COLUMN IF EXISTS season_id,
  DROP COLUMN IF EXISTS event_id,
  DROP COLUMN IF EXISTS league_season_id;

CREATE TABLE public.award_occurrences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  award_id uuid NOT NULL REFERENCES public.awards(id) ON DELETE RESTRICT,
  tournament_id uuid REFERENCES public.tournaments(id) ON DELETE SET NULL,
  event_id uuid REFERENCES public.events(id) ON DELETE SET NULL,
  elo_season_id uuid REFERENCES public.seasons(id) ON DELETE SET NULL,
  league_season_id uuid REFERENCES public.league_seasons(id) ON DELETE SET NULL,
  league_season_division_id uuid REFERENCES public.league_season_divisions(id) ON DELETE SET NULL,
  placement integer CHECK (placement IS NULL OR placement BETWEEN 0 AND 3),
  source text NOT NULL REFERENCES public.e_award_sources(value),
  effective_at timestamptz NOT NULL DEFAULT now(),
  note text,
  awarded_by bigint REFERENCES public.players(steam_id) ON DELETE SET NULL,
  calculation_key text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT award_occurrences_single_scope CHECK (num_nonnulls(tournament_id, event_id, elo_season_id, league_season_id) <= 1),
  CONSTRAINT award_occurrences_calculated_tournament CHECK (
    source <> 'tournament_calculated' OR (tournament_id IS NOT NULL AND calculation_key IS NOT NULL)
  )
);

CREATE TABLE public.award_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurrence_id uuid NOT NULL REFERENCES public.award_occurrences(id) ON DELETE RESTRICT,
  player_steam_id bigint REFERENCES public.players(steam_id) ON DELETE RESTRICT,
  team_id uuid REFERENCES public.teams(id) ON DELETE RESTRICT,
  tournament_team_id uuid REFERENCES public.tournament_teams(id) ON DELETE SET NULL,
  league_team_season_id uuid REFERENCES public.league_team_seasons(id) ON DELETE SET NULL,
  recipient_note text,
  revoked_at timestamptz,
  revoked_by bigint REFERENCES public.players(steam_id) ON DELETE SET NULL,
  revocation_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT award_recipients_exactly_one_recipient CHECK (num_nonnulls(player_steam_id, team_id) = 1),
  CONSTRAINT award_recipients_revocation_complete CHECK (
    (revoked_at IS NULL AND revoked_by IS NULL AND revocation_reason IS NULL)
    OR (revoked_at IS NOT NULL AND revocation_reason IS NOT NULL)
  )
);
CREATE UNIQUE INDEX award_recipients_occurrence_player_key ON public.award_recipients(occurrence_id, player_steam_id) WHERE player_steam_id IS NOT NULL;
CREATE UNIQUE INDEX award_recipients_occurrence_team_key ON public.award_recipients(occurrence_id, team_id) WHERE team_id IS NOT NULL;

CREATE TABLE public.tournament_award_slots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid NOT NULL REFERENCES public.tournaments(id) ON DELETE CASCADE,
  slot text NOT NULL CHECK (slot IN ('champion','runner_up','third_place','mvp')),
  award_id uuid NOT NULL REFERENCES public.awards(id) ON DELETE RESTRICT,
  custom_name text,
  silhouette_override integer CHECK (silhouette_override IS NULL OR silhouette_override BETWEEN 0 AND 4),
  image_override text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tournament_id, slot)
);

INSERT INTO public.tournament_award_slots (tournament_id, slot, award_id, custom_name, silhouette_override, image_override)
SELECT ta.tournament_id,
       CASE ta.placement WHEN 0 THEN 'mvp' WHEN 1 THEN 'champion' WHEN 2 THEN 'runner_up' WHEN 3 THEN 'third_place' END,
       COALESCE(ta.award_id, a.id), ta.custom_name, ta.silhouette, ta.image_url
FROM public.tournament_awards ta
JOIN public.awards a ON a.system_key = CASE ta.placement WHEN 0 THEN 'tournament_mvp' WHEN 1 THEN 'tournament_gold' WHEN 2 THEN 'tournament_silver' WHEN 3 THEN 'tournament_bronze' END
ON CONFLICT (tournament_id, slot) DO NOTHING;

DO $$
DECLARE r record; occurrence uuid;
BEGIN
  FOR r IN SELECT * FROM public.legacy_award_recipients_phase_a LOOP
    INSERT INTO public.award_occurrences(award_id,tournament_id,placement,source,effective_at,note,awarded_by,calculation_key)
    VALUES (r.award_id,r.tournament_id,r.placement,CASE WHEN r.source='manual' THEN 'manual' ELSE 'migration' END,r.created_at,r.note,r.awarded_by_steam_id,
      CASE WHEN r.source='manual' THEN NULL ELSE 'migration:tournament:'||r.tournament_id||':legacy:'||r.id END)
    RETURNING id INTO occurrence;
    INSERT INTO public.award_recipients(occurrence_id,player_steam_id,team_id,tournament_team_id,created_at)
    VALUES (occurrence,r.player_steam_id,r.team_id,r.tournament_team_id,r.created_at);
  END LOOP;
END $$;

ALTER TABLE public.tournaments ADD COLUMN IF NOT EXISTS trophies_enabled boolean;
UPDATE public.tournaments SET trophies_enabled = awards_enabled WHERE trophies_enabled IS NULL;
ALTER TABLE public.tournaments ALTER COLUMN trophies_enabled SET DEFAULT true;
ALTER TABLE public.tournaments ALTER COLUMN trophies_enabled SET NOT NULL;

-- Deployment-window compatibility for the currently deployed trophy UI.
CREATE VIEW public.tournament_trophies AS
SELECT r.id,o.award_id,o.tournament_id,r.tournament_team_id,r.player_steam_id,r.team_id,o.placement,
       CASE o.placement WHEN 0 THEN 'mvp' WHEN 1 THEN 'gold' WHEN 2 THEN 'silver' WHEN 3 THEN 'bronze' END AS placement_tier,
       (o.source='manual') AS manual,CASE WHEN o.source='tournament_calculated' THEN 'tournament' ELSE o.source END AS source,
       o.awarded_by AS awarded_by_steam_id,o.note,r.created_at
FROM public.award_recipients r JOIN public.award_occurrences o ON o.id=r.occurrence_id
WHERE r.revoked_at IS NULL;

CREATE FUNCTION public.sync_tournament_awards_enabled() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.awards_enabled IS DISTINCT FROM OLD.awards_enabled THEN
    NEW.trophies_enabled:=NEW.awards_enabled;
  ELSIF NEW.trophies_enabled IS DISTINCT FROM OLD.trophies_enabled THEN
    NEW.awards_enabled:=NEW.trophies_enabled;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sync_tournament_awards_enabled
BEFORE UPDATE OF awards_enabled,trophies_enabled ON public.tournaments
FOR EACH ROW EXECUTE FUNCTION public.sync_tournament_awards_enabled();

CREATE FUNCTION public.tournament_trophies_compat_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE occurrence uuid; definition uuid;
BEGIN
  IF TG_OP='DELETE' THEN
    UPDATE public.award_recipients r SET revoked_at=now(),revocation_reason='Revoked through legacy trophy API'
    FROM public.award_occurrences o WHERE r.id=OLD.id AND o.id=r.occurrence_id AND o.source='manual';
    RETURN OLD;
  END IF;
  definition:=COALESCE(
    NEW.award_id,
    public.resolve_tournament_award(NEW.tournament_id,NEW.placement)
  );
  IF COALESCE(NEW.source,'manual')='manual'
     AND EXISTS (
       SELECT 1
       FROM public.award_recipients existing
       JOIN public.award_occurrences existing_occurrence
         ON existing_occurrence.id=existing.occurrence_id
       JOIN public.awards existing_award
         ON existing_award.id=existing_occurrence.award_id
       WHERE existing_occurrence.award_id=definition
         AND existing_award.allow_multiple=false
         AND existing_occurrence.tournament_id IS NOT DISTINCT FROM NEW.tournament_id
         AND existing.revoked_at IS NULL
         AND (
           (NEW.player_steam_id IS NOT NULL AND existing.player_steam_id=NEW.player_steam_id)
           OR (NEW.team_id IS NOT NULL AND existing.team_id=NEW.team_id)
         )
     ) THEN
    RAISE EXCEPTION 'Award already granted to this recipient';
  END IF;
  INSERT INTO public.award_occurrences(award_id,tournament_id,placement,source,effective_at)
  VALUES(
    definition,
    NEW.tournament_id,
    NEW.placement,
    CASE WHEN COALESCE(NEW.source,'manual')='manual' THEN 'manual' ELSE 'tournament_calculated' END,
    now()
  ) RETURNING id INTO occurrence;
  INSERT INTO public.award_recipients(id,occurrence_id,tournament_team_id,player_steam_id,team_id)
  VALUES(COALESCE(NEW.id,gen_random_uuid()),occurrence,NEW.tournament_team_id,NEW.player_steam_id,NEW.team_id);
  RETURN NEW;
END $$;
CREATE TRIGGER tournament_trophies_compat_write INSTEAD OF INSERT OR DELETE ON public.tournament_trophies FOR EACH ROW EXECUTE FUNCTION public.tournament_trophies_compat_write();

CREATE VIEW public.tournament_trophy_configs AS
SELECT id,tournament_id,CASE slot WHEN 'mvp' THEN 0 WHEN 'champion' THEN 1 WHEN 'runner_up' THEN 2 ELSE 3 END AS placement,
 custom_name,silhouette_override AS silhouette,image_override AS image_url,created_at,updated_at
FROM public.tournament_award_slots;
CREATE FUNCTION public.tournament_trophy_configs_compat_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE slot_name text; definition uuid;
BEGIN
  slot_name:=CASE COALESCE(NEW.placement,OLD.placement) WHEN 0 THEN 'mvp' WHEN 1 THEN 'champion' WHEN 2 THEN 'runner_up' ELSE 'third_place' END;
  IF TG_OP='DELETE' THEN DELETE FROM public.tournament_award_slots WHERE id=OLD.id; RETURN OLD; END IF;
  SELECT public.resolve_tournament_award(NEW.tournament_id,NEW.placement) INTO definition;
  INSERT INTO public.tournament_award_slots(id,tournament_id,slot,award_id,custom_name,silhouette_override,image_override)
  VALUES(COALESCE(NEW.id,gen_random_uuid()),NEW.tournament_id,slot_name,definition,NEW.custom_name,NEW.silhouette,NEW.image_url)
  ON CONFLICT(tournament_id,slot) DO UPDATE SET custom_name=excluded.custom_name,silhouette_override=excluded.silhouette_override,image_override=excluded.image_override,updated_at=now();
  RETURN NEW;
END $$;
CREATE TRIGGER tournament_trophy_configs_compat_write INSTEAD OF INSERT OR UPDATE OR DELETE ON public.tournament_trophy_configs FOR EACH ROW EXECUTE FUNCTION public.tournament_trophy_configs_compat_write();
