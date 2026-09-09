CREATE TABLE IF NOT EXISTS public.e_support_request_categories (
    value text NOT NULL PRIMARY KEY,
    description text NOT NULL
);

INSERT INTO public.e_support_request_categories (value, description) VALUES
    ('general_support', 'General support'),
    ('bug_report', 'Bug report'),
    ('player_report', 'Private player report'),
    ('feedback', 'Feedback or suggestion'),
    ('organizer_application', 'Tournament organizer application')
ON CONFLICT (value) DO UPDATE SET description = EXCLUDED.description;

CREATE TABLE IF NOT EXISTS public.e_support_request_statuses (
    value text NOT NULL PRIMARY KEY,
    description text NOT NULL
);

INSERT INTO public.e_support_request_statuses (value, description) VALUES
    ('open', 'Open'),
    ('closed', 'Closed')
ON CONFLICT (value) DO UPDATE SET description = EXCLUDED.description;

CREATE TABLE IF NOT EXISTS public.support_requests (
    id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    player_steam_id bigint NOT NULL REFERENCES public.players (steam_id)
        ON UPDATE CASCADE ON DELETE CASCADE,
    category text NOT NULL REFERENCES public.e_support_request_categories (value)
        ON UPDATE CASCADE,
    subject text NOT NULL,
    initial_message text NOT NULL,
    status text NOT NULL DEFAULT 'open' REFERENCES public.e_support_request_statuses (value)
        ON UPDATE CASCADE,
    reported_player_steam_id bigint,
    reported_player_profile_url text,
    related_match_reference text,
    report_reason text,
    report_details text,
    report_evidence text,
    organizer_motivation text,
    organizer_experience text,
    organizer_languages text,
    organizer_additional_info text,
    handled_by_steam_id bigint REFERENCES public.players (steam_id)
        ON UPDATE CASCADE ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    closed_at timestamptz,
    CONSTRAINT support_requests_subject_length CHECK (
        char_length(btrim(subject)) BETWEEN 3 AND 160
    ),
    CONSTRAINT support_requests_initial_message_length CHECK (
        char_length(btrim(initial_message)) BETWEEN 10 AND 5000
    ),
    CONSTRAINT support_requests_structured_field_lengths CHECK (
        char_length(reported_player_profile_url) <= 500
        AND char_length(related_match_reference) <= 500
        AND char_length(report_reason) <= 160
        AND char_length(report_details) <= 5000
        AND char_length(report_evidence) <= 5000
        AND char_length(organizer_motivation) <= 5000
        AND char_length(organizer_experience) <= 5000
        AND char_length(organizer_languages) <= 500
        AND char_length(organizer_additional_info) <= 5000
    ),
    CONSTRAINT support_requests_player_report_fields CHECK (
        category <> 'player_report'
        OR (
            (reported_player_steam_id IS NOT NULL OR nullif(btrim(reported_player_profile_url), '') IS NOT NULL)
            AND nullif(btrim(report_reason), '') IS NOT NULL
            AND nullif(btrim(report_details), '') IS NOT NULL
        )
    ),
    CONSTRAINT support_requests_organizer_fields CHECK (
        category <> 'organizer_application'
        OR nullif(btrim(organizer_motivation), '') IS NOT NULL
    )
);

CREATE INDEX IF NOT EXISTS support_requests_player_steam_id_idx
    ON public.support_requests (player_steam_id, created_at DESC);
CREATE INDEX IF NOT EXISTS support_requests_admin_queue_idx
    ON public.support_requests (status, category, updated_at DESC);

CREATE TABLE IF NOT EXISTS public.support_request_messages (
    id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    request_id uuid NOT NULL REFERENCES public.support_requests (id)
        ON UPDATE CASCADE ON DELETE CASCADE,
    sender_steam_id bigint NOT NULL REFERENCES public.players (steam_id)
        ON UPDATE CASCADE ON DELETE CASCADE,
    is_admin boolean NOT NULL DEFAULT false,
    message text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT support_request_messages_message_length CHECK (
        char_length(btrim(message)) BETWEEN 1 AND 5000
    )
);

CREATE INDEX IF NOT EXISTS support_request_messages_request_id_idx
    ON public.support_request_messages (request_id, created_at);
