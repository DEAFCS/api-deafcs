-- account_declaration_accepted_at is real evidence, not client-controlled
-- data: the insert permission whitelists the column so the client can send a
-- truthy placeholder (its own local timestamp) to signal "the checkbox was
-- checked", but the actual persisted value always comes from the server's
-- own clock, never the client's. A missing/null value fails the insert
-- outright (ERRCODE 22000, same convention as tbiu_team_roster_status), so
-- the declaration can't be forged or skipped by calling the GraphQL API
-- directly instead of going through the verification form.
CREATE OR REPLACE FUNCTION public.tbi_verification_applications() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.account_declaration_accepted_at IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = '22000',
            MESSAGE = 'Account declaration must be accepted';
    END IF;

    NEW.account_declaration_accepted_at := now();

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbi_verification_applications ON public.verification_applications;
CREATE TRIGGER tbi_verification_applications
    BEFORE INSERT ON public.verification_applications
    FOR EACH ROW EXECUTE FUNCTION public.tbi_verification_applications();
