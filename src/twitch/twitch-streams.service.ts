import { Injectable } from "@nestjs/common";
import { PostgresService } from "../postgres/postgres.service";
import {
  isCounterStrikeStream,
  TwitchChannelStatus,
  TwitchService,
} from "./twitch.service";
import { normalizeTwitchChannel, twitchChannelUrl } from "./twitch-channel";

// A seated player's Twitch stream, shown on their live match page next to
// the match's own (manual) streams. Derived on every request from the
// lineup + the player's Twitch channel + the cached live status; never
// stored as a match_streams row, so it can't go stale or be edited/deleted
// by staff, and it disappears on its own when the match or stream ends.
export type MatchAutoStream = {
  matchId: string;
  steamId: string;
  playerName: string;
  avatarUrl: string | null;
  channel: string;
  link: string;
  title: string | null;
  gameName: string | null;
};

export type PlayerTwitch = {
  channel: string | null;
  live: boolean;
  gameName: string | null;
  title: string | null;
  checkedAt: string | null;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STEAM_ID_RE = /^\d{1,20}$/;

// Only actual gameplay shows player POVs: a Live match whose server is up
// (see the seated query). Ready check, Captain Pick, veto, waiting for a
// server, server boot and finished matches get manual streams only.
export const AUTO_STREAM_MATCH_STATUSES = ["Live"];
export const MAX_MATCHES_PER_REQUEST = 25;

export function parseMatchIds(raw: string | string[] | undefined): string[] {
  const values = (Array.isArray(raw) ? raw.join(",") : raw ?? "").split(",");
  return [
    ...new Set(values.map((v) => v.trim().toLowerCase()).filter((v) => UUID_RE.test(v))),
  ].slice(0, MAX_MATCHES_PER_REQUEST);
}

@Injectable()
export class TwitchStreamsService {
  constructor(
    private readonly postgres: PostgresService,
    private readonly twitch: TwitchService,
  ) {}

  // Public: a player's configured channel and whether it is live (any game;
  // the profile's green dot is about the channel, not about DEAFCS).
  public async getPlayerTwitch(steamId: string): Promise<PlayerTwitch | null> {
    if (!STEAM_ID_RE.test(steamId)) return null;
    const rows = await this.postgres.query<Array<{ twitch_channel: string | null }>>(
      `SELECT twitch_channel FROM public.players WHERE steam_id = $1::bigint`,
      [steamId],
    );
    if (!rows.length) return null;
    const channel = rows[0].twitch_channel;
    if (!channel) {
      return { channel: null, live: false, gameName: null, title: null, checkedAt: null };
    }
    const status = await this.twitch.getStatus(channel);
    return {
      channel,
      live: !!status?.live,
      gameName: status?.live ? status.gameName : null,
      title: status?.live ? status.title : null,
      checkedAt: status?.checkedAt ?? null,
    };
  }

  public async getOwnChannel(steamId: string): Promise<string | null> {
    const rows = await this.postgres.query<Array<{ twitch_channel: string | null }>>(
      `SELECT twitch_channel FROM public.players WHERE steam_id = $1::bigint`,
      [steamId],
    );
    return rows[0]?.twitch_channel ?? null;
  }

  // Only ever the caller's own row (steamId comes from the session).
  public async setOwnChannel(
    steamId: string,
    input: unknown,
  ): Promise<{ ok: true; channel: string | null } | { ok: false; error: string }> {
    if (input !== null && input !== undefined && typeof input !== "string") {
      return { ok: false, error: "invalid_channel" };
    }
    const normalized = normalizeTwitchChannel(input as string | null | undefined);
    if (!normalized.ok) return normalized;
    await this.postgres.query(
      `UPDATE public.players SET twitch_channel = $2 WHERE steam_id = $1::bigint`,
      [steamId, normalized.channel],
    );
    return { ok: true, channel: normalized.channel };
  }

  // Auto POV streams per match. A viewer who plays in, or coaches, a match
  // gets nothing for that match: the same anti-cheat rule the match page and
  // Watch apply to every stream of a player's own live match.
  public async getMatchAutoStreams(
    matchIds: string[],
    viewerSteamId: string | null,
  ): Promise<Record<string, MatchAutoStream[]>> {
    const result: Record<string, MatchAutoStream[]> = Object.fromEntries(
      matchIds.map((id) => [id, [] as MatchAutoStream[]]),
    );
    if (!matchIds.length) return result;

    const blocked = new Set<string>();
    if (viewerSteamId && STEAM_ID_RE.test(viewerSteamId)) {
      const rows = await this.postgres.query<Array<{ id: string }>>(
        `SELECT m.id
           FROM public.matches m
          WHERE m.id = ANY($1::uuid[])
            AND (
              EXISTS (
                SELECT 1 FROM public.match_lineup_players mlp
                 WHERE mlp.match_lineup_id IN (m.lineup_1_id, m.lineup_2_id)
                   AND mlp.steam_id = $2::bigint
              )
              OR EXISTS (
                SELECT 1 FROM public.match_lineups ml
                 WHERE ml.match_id = m.id
                   AND ml.coach_steam_id = $2::bigint
              )
            )`,
        [matchIds, viewerSteamId],
      );
      for (const row of rows) blocked.add(row.id);
    }

    const visible = matchIds.filter((id) => !blocked.has(id));
    if (!visible.length) return result;

    const seated = await this.postgres.query<
      Array<{
        match_id: string;
        steam_id: string;
        name: string;
        avatar_url: string | null;
        twitch_channel: string;
      }>
    >(
      `SELECT m.id AS match_id,
              p.steam_id::text AS steam_id,
              p.name,
              p.avatar_url,
              p.twitch_channel
         FROM public.matches m
         JOIN public.match_lineup_players mlp
           ON mlp.match_lineup_id IN (m.lineup_1_id, m.lineup_2_id)
         JOIN public.players p ON p.steam_id = mlp.steam_id
        WHERE m.id = ANY($1::uuid[])
          AND m.status = ANY($2::text[])
          AND m.server_id IS NOT NULL
          AND public.is_server_online(m) IS TRUE
          AND p.twitch_channel IS NOT NULL
        ORDER BY p.name`,
      [visible, AUTO_STREAM_MATCH_STATUSES],
    );
    if (!seated.length) return result;

    const statuses: Record<string, TwitchChannelStatus> =
      await this.twitch.getStatuses(seated.map((row) => row.twitch_channel));

    for (const row of seated) {
      const status = statuses[row.twitch_channel];
      // Live on Twitch AND playing Counter-Strike: a player streaming
      // another game during the match is not attached to it.
      if (!status || !isCounterStrikeStream(status)) continue;
      const list = result[row.match_id] ?? (result[row.match_id] = []);
      if (list.some((s) => s.channel === row.twitch_channel)) continue;
      list.push({
        matchId: row.match_id,
        steamId: row.steam_id,
        playerName: row.name,
        avatarUrl: row.avatar_url,
        channel: row.twitch_channel,
        link: twitchChannelUrl(row.twitch_channel),
        title: status.title,
        gameName: status.gameName,
      });
    }
    return result;
  }
}
