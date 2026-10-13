import { PostgresService } from "../postgres/postgres.service";
import { User } from "../auth/types/User";
import type { PoolClient } from "pg";

export function directParties(room: string): string[] | null {
  if (typeof room !== "string") return null;
  const parts = room.split(":");
  if (parts.length !== 2 || parts.some((id) => !/^[1-9][0-9]{0,18}$/.test(id)))
    return null;
  try {
    if (
      parts.some((id) => BigInt(id) > 9223372036854775807n) ||
      BigInt(parts[0]) >= BigInt(parts[1])
    )
      return null;
  } catch {
    return null;
  }
  return parts;
}
export interface DirectSendContext {
  request: boolean;
  record: (messageId: string) => Promise<void>;
  afterCommit: Array<() => Promise<unknown> | void>;
  rollback: Array<() => Promise<unknown>>;
}
const REFUSED = Symbol("direct-send-refused");
// Upstream conversation/request state and SQL policy. Message content continues
// using DEAFCS Redis history and its existing TTL; this table stores only the
// send ledger needed to enforce the one-message rule even after content expiry.
export class DirectRequestsService {
  constructor(
    private readonly postgres: PostgresService,
    private readonly onSideEffectError: (error: unknown) => void = () => {},
  ) {}
  async canView(room: string, user: User): Promise<boolean> {
    if (!directParties(room)?.includes(String(user?.steam_id))) return false;
    const [row] = await this.postgres.query<Array<{ allowed: boolean }>>(
      "SELECT public.can_view_direct_room($1, $2::bigint) AS allowed",
      [room, user.steam_id],
    );
    return row?.allowed === true;
  }
  async refusal(room: string, user: User): Promise<string | null> {
    if (!directParties(room)?.includes(String(user?.steam_id)))
      return "not_allowed";
    const [row] = await this.postgres.query<Array<{ reason: string | null }>>(
      "SELECT public.direct_message_refusal($1, $2::bigint) AS reason",
      [room, user.steam_id],
    );
    return row ? row.reason : "not_allowed";
  }
  async send<T extends { accepted: boolean }>(
    room: string,
    user: User,
    action: (context: DirectSendContext) => Promise<T>,
    retryId?: string,
  ): Promise<T | { accepted: false; errorCode: string }> {
    const parties = directParties(room);
    if (!parties?.includes(String(user?.steam_id)))
      return { accepted: false, errorCode: "not_allowed" };
    let context: DirectSendContext;
    let denied = "not_allowed";
    let committed = false;
    let recordedId: string | undefined;
    let sendResult: T | undefined;
    try {
      const result = await this.postgres.transaction(async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          "direct:" + room,
        ]);
        // Lock consent rows in canonical order and existing accepted friendships.
        // A toggle/removal which commits first is seen by the policy; one which
        // starts later waits until this send commits. Existing blocks are not changed.
        const players = await client.query(
          "SELECT steam_id FROM public.players WHERE steam_id = ANY($1::bigint[]) ORDER BY steam_id FOR SHARE",
          [parties],
        );
        if (players.rows.length !== 2) throw REFUSED;
        await client.query(
          "SELECT player_steam_id FROM public.friends WHERE status = 'Accepted' AND ((player_steam_id=$1::bigint AND other_player_steam_id=$2::bigint) OR (player_steam_id=$2::bigint AND other_player_steam_id=$1::bigint)) ORDER BY player_steam_id FOR SHARE",
          parties,
        );
        const {
          rows: [policy],
        } = await client.query(
          "SELECT public.direct_message_refusal($1, $2::bigint) AS reason",
          [room, user.steam_id],
        );
        // Stable retries acknowledge only this actor's committed ledger entry.
        // Blocked/disabled policy never becomes an idempotency bypass.
        if (!policy || (policy.reason && policy.reason !== "awaiting_reply")) {
          throw REFUSED;
        }
        if (
          retryId &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            retryId,
          )
        ) {
          const { rows } = await client.query(
            "SELECT id FROM public.direct_messages WHERE id = $1::uuid AND room_id = $2 AND from_steam_id = $3::bigint",
            [retryId, room, user.steam_id],
          );
          if (rows.length) return { accepted: true } as T;
        }
        if (policy.reason) {
          denied = "awaiting_reply";
          throw REFUSED;
        }
        let recorded = false;
        context = {
          request: false,
          afterCommit: [],
          rollback: [],
          record: async (messageId) => {
            if (recorded)
              throw new Error("direct send may record only one message");
            const { rows } = await client.query(
              "INSERT INTO public.direct_messages (id, room_id, from_steam_id) SELECT $1::uuid, $2, $3::bigint WHERE NOT public.is_blocked_either_way(($4::bigint[])[1], ($4::bigint[])[2]) RETURNING id",
              [messageId, room, user.steam_id, parties],
            );
            if (!rows.length) throw REFUSED;
            recorded = true;
            recordedId = messageId;
            const state = await this.recordConversation(
              client,
              room,
              parties,
              String(user.steam_id),
            );
            context.request = state.some(
              (row) =>
                row.steam_id !== String(user.steam_id) && !row.accepted_at,
            );
          },
        };
        const result = await action(context);
        sendResult = result;
        if (!result.accepted) {
          denied = "not_allowed";
          throw { refusedResult: result };
        }
        if (!recorded)
          throw new Error("direct send accepted without a ledger entry");
        const {
          rows: [blocked],
        } = await client.query(
          "SELECT public.is_blocked_either_way($1::bigint,$2::bigint) AS blocked",
          parties,
        );
        if (!blocked || blocked.blocked) throw REFUSED;
        return result;
      });
      committed = true;
      for (const deliver of context?.afterCommit ?? []) {
        try {
          await deliver();
        } catch (error) {
          this.onSideEffectError(error);
        }
      }
      return result;
    } catch (error) {
      if (committed) throw error;
      if (context) {
        // COMMIT can succeed while its acknowledgement is lost. Reconcile the
        // ledger under the same room lock before undoing Redis or a video claim;
        // a concurrent committed retry must never be erased by compensation.
        let ledgerCommitted = false;
        try {
          await this.postgres.transaction(async (client) => {
            await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
              "direct:" + room,
            ]);
            if (recordedId) {
              const { rows } = await client.query(
                "SELECT id FROM public.direct_messages WHERE id=$1::uuid AND room_id=$2 AND from_steam_id=$3::bigint",
                [recordedId, room, user.steam_id],
              );
              ledgerCommitted = rows.length > 0;
            }
            if (!ledgerCommitted) {
              for (const undo of [...context.rollback].reverse()) {
                try {
                  await undo();
                } catch (undoError) {
                  this.onSideEffectError(undoError);
                }
              }
            }
          });
        } catch (reconcileError) {
          // With no database confirmation it is unsafe to erase possibly
          // committed history. Log and leave the original failure retryable.
          this.onSideEffectError(reconcileError);
          throw error;
        }
        if (ledgerCommitted) {
          for (const deliver of context.afterCommit) {
            try {
              await deliver();
            } catch (deliveryError) {
              this.onSideEffectError(deliveryError);
            }
          }
          return sendResult ?? ({ accepted: true } as T);
        }
      }
      if (error === REFUSED) return { accepted: false, errorCode: denied };
      if (error?.refusedResult) return error.refusedResult;
      throw error;
    }
  }
  private async recordConversation(
    client: PoolClient,
    room: string,
    parties: string[],
    from: string,
  ) {
    const { rows } = await client.query(
      `WITH incoming AS (
         SELECT party.steam_id, CASE WHEN party.steam_id = $3::bigint
           OR public.are_friends(($2::bigint[])[1], ($2::bigint[])[2]) THEN now() END AS accepted_at
         FROM unnest($2::bigint[]) AS party(steam_id)
       ) INSERT INTO public.direct_conversations
          (room_id, steam_id, last_message_at, is_open, position, accepted_at)
          SELECT $1, steam_id, now(), accepted_at IS NOT NULL, 0, accepted_at FROM incoming
       ON CONFLICT (room_id, steam_id) DO UPDATE SET
          last_message_at = EXCLUDED.last_message_at,
          accepted_at = COALESCE(direct_conversations.accepted_at, EXCLUDED.accepted_at),
          declined_at = CASE WHEN EXCLUDED.accepted_at IS NOT NULL THEN NULL ELSE direct_conversations.declined_at END,
          is_open = direct_conversations.is_open OR COALESCE(direct_conversations.accepted_at, EXCLUDED.accepted_at) IS NOT NULL
       RETURNING steam_id::text, accepted_at`,
      [room, parties, from],
    );
    return rows as Array<{ steam_id: string; accepted_at: Date | null }>;
  }
  // Only new, ledger-tagged Redis records need this check. Legacy history
  // remains readable under the existing room authorization policy.
  async filterCommittedMessages(
    room: string,
    user: User,
    messages: Array<Record<string, any>>,
  ) {
    if (!(await this.canView(room, user))) return [];
    const tagged = messages.filter((message) => message.directLedger === true);
    const ids = tagged
      .map((message) => String(message.id))
      .filter((id) =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          id,
        ),
      );
    const rows = ids.length
      ? await this.postgres.query<Array<{ id: string }>>(
          "SELECT id FROM public.direct_messages WHERE room_id=$1 AND id=ANY($2::uuid[])",
          [room, ids],
        )
      : [];
    const committed = new Set(rows.map((row) => row.id));
    return messages
      .filter(
        (message) =>
          message.directLedger !== true || committed.has(String(message.id)),
      )
      .map((message) => {
        const { directLedger, ...visible } = message;
        return visible;
      });
  }
  async isCommittedMessage(room: string, user: User, id: string) {
    return (
      (
        await this.filterCommittedMessages(room, user, [
          { id, directLedger: true },
        ])
      ).length === 1
    );
  }
  async decline(room: string, user: User): Promise<void> {
    if (!directParties(room)?.includes(String(user?.steam_id))) return;
    await this.postgres.query(
      `UPDATE public.direct_conversations SET declined_at = now(), is_open = false
      WHERE room_id = $1 AND steam_id = $2::bigint AND accepted_at IS NULL`,
      [room, user.steam_id],
    );
  }
  async markRead(room: string, user: User): Promise<void> {
    if (!(await this.canView(room, user))) return;
    await this.postgres.query(
      `INSERT INTO public.chat_read_state (steam_id, thread, last_read_at) VALUES ($1::bigint, $2, now())
      ON CONFLICT (steam_id, thread) DO UPDATE SET last_read_at = now()`,
      [user.steam_id, "chat:direct:" + room],
    );
  }
  async conversations(user: User) {
    if (
      !/^[1-9][0-9]{0,18}$/.test(String(user?.steam_id)) ||
      BigInt(user.steam_id) > 9223372036854775807n
    )
      return [];
    const rows = await this.postgres.query<Array<any>>(
      `SELECT dc.room_id, dc.is_open, dc.accepted_at IS NULL AS request,
      public.direct_message_refusal(dc.room_id, dc.steam_id) IS NOT DISTINCT FROM 'awaiting_reply' AS awaiting_reply,
      (SELECT count(*) FROM public.direct_messages dm WHERE dm.room_id = dc.room_id AND dm.from_steam_id <> dc.steam_id
        AND (crs.last_read_at IS NULL OR dm.created_at > crs.last_read_at))::int AS unread,
      p.steam_id::text AS peer_steam_id, p.name AS peer_name, COALESCE(p.custom_avatar_url,p.avatar_url) AS peer_avatar_url
      FROM public.direct_conversations dc
      LEFT JOIN public.chat_read_state crs ON crs.steam_id = dc.steam_id AND crs.thread = 'chat:direct:' || dc.room_id
      JOIN public.players p ON p.steam_id = CASE WHEN split_part(dc.room_id,':',1)::bigint = dc.steam_id THEN split_part(dc.room_id,':',2)::bigint ELSE split_part(dc.room_id,':',1)::bigint END
      WHERE dc.steam_id = $1::bigint AND dc.declined_at IS NULL
        AND NOT public.is_blocked_either_way(dc.steam_id,p.steam_id)
      ORDER BY (dc.accepted_at IS NULL) DESC, dc.last_message_at DESC LIMIT 100`,
      [user.steam_id],
    );
    return rows.map((row) => ({
      roomId: row.room_id,
      isOpen: row.is_open,
      unread: Number(row.unread),
      request: row.request,
      awaitingReply: row.awaiting_reply,
      peer: {
        steam_id: row.peer_steam_id,
        name: row.peer_name,
        avatar_url: row.peer_avatar_url,
      },
    }));
  }
}
