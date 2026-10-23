# WebSocket safety, local preparation (2026-10-10)

Status: rebased 2026-10-23 on the production base `b214934f` (branch `fix/websocket-safety`), plus the DEAFCS leaver-timeout guard below. Not deployed; needs a controlled real-server test first.

Upstream: https://github.com/5stackgg/api/commit/2717daa6aa72e5178858be16b50b9f26d4b31ab2 and https://github.com/5stackgg/api/commit/bf9edfa9afd0a0be1d2e3314fe2f74e7a4205b8b .

The gateway now waits for authentication, terminates failed auth, binds events to the authenticated server's assigned match, and verifies map IDs inside event payloads. Refused events are acknowledged to stop permanent redelivery; processing/database failures remain unacknowledged and do not set the dedup key. Credentials are revalidated so rotation/deletion revokes existing sockets. A failed credential query keeps the socket connected but refuses to process the event, allowing retry after recovery.

Active matches retain upstream's five-second connection-local binding/credential caches. After a match ends, only the last known host may send chat, disconnects and terminal map statuses (WaitingForTV, UploadingDemo, Finished). The last-host Redis key lasts ten minutes. Results cannot be changed after the terminal binding is observed.

Captain updates are scoped to this match's lineups, and placeholders with no Steam/Discord ID are dropped. Player-name upsert conflicts are limited to this match's lineup members and retain the registered-name protection. Abandon events are refused for players outside this match.

## Files and separation

- src/matches/match-events.gateway.ts and .spec.ts
- src/matches/events/CaptainEvent.ts and .spec.ts
- src/matches/events/MatchAbandoned.ts and .spec.ts
- src/matches/events/abstracts/MatchEventProcessor.ts and .spec.ts
- src/matches/events/PlayerConnected.ts, PlayersConnected.ts, MatchUpdatedLineupsEvent.ts

These files form the WebSocket-only change. Local commit title: fix(matches): port upstream game-server websocket safety.

## Intentional DEAFCS differences

Gateway production code is the bf9edfa version with DEAFCS's existing received-event debug log retained. Upstream gateway and captain/name tests are copied with the extra Postgres/DisconnectBudget constructor arguments required here.

DEAFCS's player-connect SQL, placeholder resolution and disconnect budget behavior remain intact. Only the name-conflict clause is replaced in those processors. The abstract processor retains its existing constructor and match-ID normalization.

DEAFCS does not have upstream's existing abandon dedup/admin-notification implementation. Only bf9edfa's membership guard is ported, preserving the existing insert. No abandonment schema, cooldown or notification redesign is included.

`leaver-timeout` (LeaverTimeout) exists only in DEAFCS. It applies an escalating leaver ban and an ELO penalty, so it gets the same lineup-membership guard as MatchAbandoned: a player outside this match is refused and never banned. After a match has ended, the gateway refuses `leaver-timeout` and `abandoned` (they are not in the after-match-end allowlist), as upstream does for `abandoned`.

## Checks and limits

The combined local API chat/match run passed 474 tests across 30 suites, including all existing orphan teardown/reconciliation tests. The initial gateway/captain/name run passed 74 tests. API compilation with tsc --project tsconfig.build.json --noEmit passed. Final diffs were reviewed and git diff --check passed.

As upstream documents, reassignment, match-end and credential revocation may take up to five seconds to be observed by a warm socket. Revocation is checked on the next event, not by an idle timer. These are intentional upstream tradeoffs to avoid per-event Hasura reads during high-frequency game events. The last host must have been observed before server_id is cleared; an unknown host after an API/cache restart is refused safely. No live match, network load or production verification was performed.

## Finalization reconnect checks

Fresh connections authenticate through handleConnection with the Basic authorization header, get their own match-binding cache and immediately accept a legitimate current host. Replayed successful message IDs are acknowledged without duplicate processing. A fresh stale-host connection is refused immediately, independent of the old socket cache. New credentials authenticate immediately after rotation; old credentials fail the new handshake. Exact boundary tests confirm a warm binding/credential is valid at 4,999 ms and revalidated at 5,000 ms. These tests use mocked sockets/Hasura/cache; no real CS2 instance or live TCP connection was used.

## Changed files (relative to b214934f)

- `UPSTREAM_WEBSOCKET_SAFETY.md`
- `src/matches/match-events.gateway.ts` and `.spec.ts`
- `src/matches/events/MatchAbandoned.ts` and `.spec.ts`
- `src/matches/events/LeaverTimeout.ts` and `.spec.ts` (DEAFCS)
- `src/matches/events/MatchUpdatedLineupsEvent.ts`
- `src/matches/events/PlayerConnected.ts`, `PlayersConnected.ts`
- `src/matches/events/abstracts/MatchEventProcessor.ts` and `.spec.ts`

`CaptainEvent.ts` and its spec were already identical to upstream on the base.
