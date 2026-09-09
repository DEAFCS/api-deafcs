CREATE OR REPLACE FUNCTION public.tbu_support_requests() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at := now();

    IF NEW.status = 'closed' AND OLD.status <> 'closed' THEN
        NEW.closed_at := now();
    ELSIF NEW.status <> 'closed' AND OLD.status = 'closed' THEN
        NEW.closed_at := NULL;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tbu_support_requests ON public.support_requests;
CREATE TRIGGER tbu_support_requests
    BEFORE UPDATE ON public.support_requests
    FOR EACH ROW EXECUTE FUNCTION public.tbu_support_requests();

CREATE OR REPLACE FUNCTION public.tai_support_request_messages() RETURNS TRIGGER
    LANGUAGE plpgsql
    AS $$
BEGIN
    UPDATE public.support_requests
    SET updated_at = now()
    WHERE id = NEW.request_id;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tai_support_request_messages ON public.support_request_messages;
CREATE TRIGGER tai_support_request_messages
    AFTER INSERT ON public.support_request_messages
    FOR EACH ROW EXECUTE FUNCTION public.tai_support_request_messages();
