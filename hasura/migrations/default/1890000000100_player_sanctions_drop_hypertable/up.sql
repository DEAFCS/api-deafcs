-- player_sanctions was made a hypertable alongside the per-event stats tables,
-- but every lookup (is_banned, is_muted, is_gagged, ...) filters on
-- player_steam_id alone. Without a predicate on the partitioning column chunk
-- exclusion cannot prune anything, so each lookup fans a sequential scan across
-- every chunk instead of using idx_player_sanctions_steam_type. The table holds
-- a few hundred rows; partitioning only adds planning and scan cost.
-- Same change as upstream 5stack migration 1886000000800, adapted to the extra
-- columns this fork added (revoked_by_steam_id, evidence_message_id,
-- notify_teammates) and its triggers.
DO $$
DECLARE
    trigger_definitions text[];
    trigger_definition text;
    active_function_definition text;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM timescaledb_information.hypertables
        WHERE hypertable_schema = 'public' AND hypertable_name = 'player_sanctions'
    ) THEN
        RAISE NOTICE 'player_sanctions is already a plain table, skipping';
        RETURN;
    END IF;

    LOCK TABLE public.player_sanctions IN ACCESS EXCLUSIVE MODE;

    -- Triggers (Hasura event triggers, guards) are dropped together with the
    -- old table; capture them and recreate them at the end.
    SELECT coalesce(array_agg(pg_get_triggerdef(oid)), '{}')
      INTO trigger_definitions
      FROM pg_trigger
     WHERE tgrelid = 'public.player_sanctions'::regclass
       AND NOT tgisinternal;

    -- Computed-field function that takes the row type; it blocks DROP TABLE.
    -- hasura/functions/ is applied after the migrations, so on a fresh database
    -- it does not exist yet and there is nothing to preserve.
    IF to_regprocedure('public.player_sanction_is_active(public.player_sanctions)') IS NOT NULL THEN
        SELECT pg_get_functiondef('public.player_sanction_is_active(public.player_sanctions)'::regprocedure)
          INTO active_function_definition;
        DROP FUNCTION public.player_sanction_is_active(public.player_sanctions);
    END IF;

    CREATE TABLE public.player_sanctions_plain (
        LIKE public.player_sanctions INCLUDING DEFAULTS
    );

    INSERT INTO public.player_sanctions_plain SELECT * FROM public.player_sanctions;

    DROP TABLE public.player_sanctions;
    ALTER TABLE public.player_sanctions_plain RENAME TO player_sanctions;

    ALTER TABLE public.player_sanctions
        ADD CONSTRAINT player_sanctions_pkey PRIMARY KEY (id);

    ALTER TABLE public.player_sanctions
        ADD CONSTRAINT player_sanctions_player_steam_id_fkey
        FOREIGN KEY (player_steam_id) REFERENCES public.players(steam_id)
        ON UPDATE CASCADE ON DELETE CASCADE;

    ALTER TABLE public.player_sanctions
        ADD CONSTRAINT player_sanctions_revoked_by_steam_id_fkey
        FOREIGN KEY (revoked_by_steam_id) REFERENCES public.players(steam_id)
        ON UPDATE CASCADE ON DELETE SET NULL;

    ALTER TABLE public.player_sanctions
        ADD CONSTRAINT player_sanctions_sanctioned_by_steam_id_fkey
        FOREIGN KEY (sanctioned_by_steam_id) REFERENCES public.players(steam_id)
        ON UPDATE CASCADE ON DELETE SET NULL;

    ALTER TABLE public.player_sanctions
        ADD CONSTRAINT player_sanctions_type_fkey
        FOREIGN KEY (type) REFERENCES public.e_sanction_types(value)
        ON UPDATE CASCADE ON DELETE RESTRICT;

    CREATE INDEX idx_player_sanctions_steam_type
        ON public.player_sanctions (player_steam_id, type);

    CREATE INDEX idx_player_sanctions_one_auto_ban
        ON public.player_sanctions (player_steam_id)
        WHERE type = 'ban' AND sanctioned_by_steam_id IS NULL;

    CREATE INDEX player_sanctions_created_at_idx
        ON public.player_sanctions (created_at DESC);

    IF active_function_definition IS NOT NULL THEN
        EXECUTE active_function_definition;
    END IF;

    FOREACH trigger_definition IN ARRAY trigger_definitions LOOP
        EXECUTE trigger_definition;
    END LOOP;
END;
$$;
