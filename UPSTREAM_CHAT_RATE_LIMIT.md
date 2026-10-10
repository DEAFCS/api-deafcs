# Chat rate limiting, local preparation (2026-10-10)

Status: implementation finalized and locally tested for a separate local commit. No production action.

Upstream: https://github.com/5stackgg/api/commit/d2d7f616d3229436eec14018c632d62c7223602c .

Uses upstream's MESSAGE_RATE_LIMIT=5, MESSAGE_RATE_WINDOW_MS=3000, RATE_SCRIPT and withinRate algorithm. One atomic Redis INCR/PEXPIRE counter per Steam ID is shared across rooms and API instances. The expiry is only set on the first increment, so rejected sends do not extend the window. Website sends are checked before sendMessageToChat performs permission queries, message persistence, broadcasts, unread/push notifications or game relay. Game-relayed messages are exempt. Valid failed-send retries count toward the same budget; failure of Redis propagates and no message is persisted or relayed.

## Files and separation

- src/chat/chat.service.ts, chat.gateway.ts, chat-video.controller.ts
- src/chat/chat-rate-limit.spec.ts
- src/chat/chat.service.spec.ts, chat-blocking.spec.ts, chat-moderation.spec.ts, chat-video.spec.ts

These files form the chat-only change. Local commit title: fix(chat): port upstream website message rate limiting.

## Intentional DEAFCS differences

Upstream now uses a different source/error contract and has reaction rate limiting that DEAFCS does not have. No new error enum or unrelated reaction refactor is introduced. DEAFCS keeps source=website/game and adds rateLimited to its existing result object. The existing chat:send:error frontend listener displays the rate rejection; video send routes return HTTP 429. The current WEB already handles these errors, so no WEB change is needed.

DEAFCS validates text length, blank content, GIF host and match attachment restrictions before the rate counter. Valid text, images, GIFs and new short-video sends share the same budget. All DEAFCS room enums, access checks, mentions, message TTLs, clientId echoes and notification behavior are preserved.

Short-video wrappers retain their capability/owner validation, existing-message reconciliation and committed retry behavior before entering sendMessageToChat. This may involve Redis, Hasura or an announcement lookup before the limiter; those identity/idempotency checks are intentionally preserved. New message persistence still passes the shared limiter. A rejected ready draft remains ready and can be sent later; retrying an already committed video does not send or notify twice.

Existing Redis mocks are adapted for the numeric counter response. The game-origin mute test now supplies source=game, matching the real game event caller.

## Checks and limits

Combined API chat/match regressions: 474 tests in 30 suites passed. Targeted WEB Chat Hub, room, Captain Pick, mentions and video regressions: 96 tests in 6 files passed, with Vue fixture warnings. API tsc --project tsconfig.build.json --noEmit and git diff --check passed.

Coverage includes legitimate messages and attachment-only sends, cross-room spam, shared-instance concurrency, player isolation, expiry/recovery, game-origin exemption, failed persistence retries, Redis failure, no notifications/RCON on rate rejection, HTTP/WebSocket errors and video retry/idempotency. Existing restrictions, blocking, reactions, edits and channel tests pass.

Counter concurrency/expiry tests use a shared in-memory Redis test double; no real Redis instance or production database was contacted. This is the same fixed-window behavior as upstream: a boundary may permit adjacent bursts, and Redis outages temporarily prevent website sends. Plain text retry deduplication is not newly introduced. Frontend composer/toast behavior was inspected and tested locally, but a real API/browser/Redis integration remains unverified.

## Finalization room checks

Each of the eleven existing ChatLobbyType values is tested against the same Steam-ID budget, including MatchTeam, CaptainPickTeam, matchmaking and announcements. Access remains separately enforced by the existing production gates. The room-matrix tests exercise the common limiter in isolation; existing channel access tests cover the permission gates.

## Exact local commit file manifest

- `C:/Users/TricoN/Desktop/DEAFCS/api-deafcs/UPSTREAM_CHAT_RATE_LIMIT.md`
- `C:/Users/TricoN/Desktop/DEAFCS/api-deafcs/src/chat/chat.service.ts`
- `C:/Users/TricoN/Desktop/DEAFCS/api-deafcs/src/chat/chat.gateway.ts`
- `C:/Users/TricoN/Desktop/DEAFCS/api-deafcs/src/chat/chat-video.controller.ts`
- `C:/Users/TricoN/Desktop/DEAFCS/api-deafcs/src/chat/chat-rate-limit.spec.ts`
- `C:/Users/TricoN/Desktop/DEAFCS/api-deafcs/src/chat/chat.service.spec.ts`
- `C:/Users/TricoN/Desktop/DEAFCS/api-deafcs/src/chat/chat-blocking.spec.ts`
- `C:/Users/TricoN/Desktop/DEAFCS/api-deafcs/src/chat/chat-moderation.spec.ts`
- `C:/Users/TricoN/Desktop/DEAFCS/api-deafcs/src/chat/chat-video.spec.ts`
