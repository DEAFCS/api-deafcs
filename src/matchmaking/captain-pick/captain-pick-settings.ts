export const CAPTAIN_PICK_ENABLED_SETTING =
  "public.matchmaking_competitive_captain_pick";
export const CAPTAIN_PICK_SECONDS_SETTING =
  "public.matchmaking_captain_pick_seconds";

export const DEFAULT_CAPTAIN_PICK_SECONDS = 30;
export const MIN_CAPTAIN_PICK_SECONDS = 10;
export const MAX_CAPTAIN_PICK_SECONDS = 120;

export interface CaptainPickSettings {
  enabled: boolean;
  pickSeconds: number;
}

// Off unless an administrator explicitly turned it on. The opposite of the
// public.matchmaking_{type} toggles, which count as on when absent.
export function parseCaptainPickEnabled(
  value: string | null | undefined,
): boolean {
  return value === "true";
}

export function parseCaptainPickSeconds(
  value: string | number | null | undefined,
): number {
  if (value === null || value === undefined) {
    return DEFAULT_CAPTAIN_PICK_SECONDS;
  }

  const trimmed = typeof value === "string" ? value.trim() : value;
  if (trimmed === "") {
    return DEFAULT_CAPTAIN_PICK_SECONDS;
  }

  const seconds = Number(trimmed);
  if (!Number.isFinite(seconds)) {
    return DEFAULT_CAPTAIN_PICK_SECONDS;
  }

  return Math.min(
    MAX_CAPTAIN_PICK_SECONDS,
    Math.max(MIN_CAPTAIN_PICK_SECONDS, Math.floor(seconds)),
  );
}

export function parseCaptainPickSettings(
  settings: Array<{ name: string; value?: string | null }>,
): CaptainPickSettings {
  const valueOf = (name: string) =>
    settings.find((setting) => setting.name === name)?.value;

  return {
    enabled: parseCaptainPickEnabled(valueOf(CAPTAIN_PICK_ENABLED_SETTING)),
    pickSeconds: parseCaptainPickSeconds(valueOf(CAPTAIN_PICK_SECONDS_SETTING)),
  };
}

export interface CaptainPickTimer {
  startedAt: Date;
  timerSeconds: number;
  deadline: Date;
}

/**
 * A pick's deadline is fixed when that pick starts, from the timer setting at
 * that moment. An admin changing the setting mid-pick only affects the next
 * pick, never a deadline a captain is already looking at.
 */
export function startCaptainPickTimer(
  startedAt: Date,
  timerSeconds: number,
): CaptainPickTimer {
  const seconds = parseCaptainPickSeconds(timerSeconds);

  return {
    startedAt,
    timerSeconds: seconds,
    deadline: new Date(startedAt.getTime() + seconds * 1000),
  };
}
