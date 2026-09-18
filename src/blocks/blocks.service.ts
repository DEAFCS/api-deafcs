import { Injectable } from "@nestjs/common";
import { PostgresService } from "src/postgres/postgres.service";

@Injectable()
export class BlocksService {
  constructor(private readonly postgres: PostgresService) {}

  // True if a block exists between the two players in EITHER direction --
  // every enforcement point (friend requests, DMs, invites) is meant to be
  // symmetric: it doesn't matter who blocked whom, neither side can
  // interact with the other while the block stands.
  public async isBlockedEitherDirection(
    steamIdA: string,
    steamIdB: string,
  ): Promise<boolean> {
    if (steamIdA === steamIdB) {
      return false;
    }

    const rows = await this.postgres.query<Array<{ exists: boolean }>>(
      `SELECT EXISTS (
         SELECT 1 FROM public.player_blocks
          WHERE (blocker_steam_id = $1::bigint AND blocked_steam_id = $2::bigint)
             OR (blocker_steam_id = $2::bigint AND blocked_steam_id = $1::bigint)
       ) AS exists`,
      [steamIdA, steamIdB],
    );

    return Boolean(rows[0]?.exists);
  }

  // Directional: true only if `blockerSteamId` specifically has blocked
  // `blockedSteamId` -- the other direction doesn't count. Used for chat
  // visibility, which is entirely about the viewer's own block list (B
  // blocking A does not hide B's messages from A).
  public async hasBlocked(
    blockerSteamId: string,
    blockedSteamId: string,
  ): Promise<boolean> {
    if (blockerSteamId === blockedSteamId) {
      return false;
    }
    const rows = await this.postgres.query<Array<{ exists: boolean }>>(
      `SELECT EXISTS (
         SELECT 1 FROM public.player_blocks
          WHERE blocker_steam_id = $1::bigint AND blocked_steam_id = $2::bigint
       ) AS exists`,
      [blockerSteamId, blockedSteamId],
    );
    return Boolean(rows[0]?.exists);
  }

  // Of `candidateSteamIds`, returns the subset that have blocked
  // `blockedSteamId` -- i.e. the set of viewers who should not see content
  // from/be notified by that one sender. Direction matters here (unlike
  // isBlockedEitherDirection): only the viewer's own block counts, so a
  // sender who themselves blocked a candidate doesn't hide anything from
  // that candidate.
  public async getViewersBlocking(
    candidateSteamIds: string[],
    blockedSteamId: string,
  ): Promise<Set<string>> {
    const candidates = [...new Set(candidateSteamIds)].filter(
      (steamId) => steamId !== blockedSteamId,
    );
    if (candidates.length === 0) {
      return new Set();
    }

    const rows = await this.postgres.query<
      Array<{ blocker_steam_id: string }>
    >(
      `SELECT blocker_steam_id::text AS blocker_steam_id
         FROM public.player_blocks
        WHERE blocked_steam_id = $1::bigint
          AND blocker_steam_id = ANY($2::bigint[])`,
      [blockedSteamId, candidates],
    );

    return new Set(rows.map((row) => row.blocker_steam_id));
  }

  // The steam ids `steamId` has personally blocked (outgoing direction
  // only) -- used to redact those senders' messages when `steamId` is the
  // one loading/viewing a shared room's history.
  public async getMyBlockedSteamIds(steamId: string): Promise<Set<string>> {
    const rows = await this.postgres.query<
      Array<{ blocked_steam_id: string }>
    >(
      `SELECT blocked_steam_id::text AS blocked_steam_id
         FROM public.player_blocks
        WHERE blocker_steam_id = $1::bigint`,
      [steamId],
    );
    return new Set(rows.map((row) => row.blocked_steam_id));
  }
}
