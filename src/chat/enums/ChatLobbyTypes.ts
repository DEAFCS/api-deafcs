export enum ChatLobbyType {
  Match = "match",
  Team = "team",
  MatchMaking = "matchmaking",
  Tournament = "tournament",
  Organizer = "organizers",
  Draft = "draft",
  // Per-match, per-lineup chat -- distinct from Team (a persistent Team
  // entity's own chat room, which matchmaking/draft lineups don't have).
  // id is `${matchId}:${lineupId}`. Web-only: ChatGateway's relay to the
  // in-game CS2 server is already hard-scoped to ChatLobbyType.Match only,
  // so this never reaches the game server.
  MatchTeam = "match_team",
  // Private team chat during a matchmaking Captain Pick draft, before any
  // match (and so any match_team lineup) exists. id is
  // `${draftId}:${lineup}` (lineup 1 or 2). Access comes only from the
  // committed draft state in Redis (see captain-pick-team-chat.ts), never
  // from the client, and messages expire with the draft.
  CaptainPickTeam = "captain_pick_team",
  // Shared "Match Chat" of a matchmaking Captain Pick draft, before the
  // match exists. id is the draftId. Only the ten players committed to
  // that draft (Redis state, see captain-pick-team-chat.ts), no admin
  // bypass, messages expire with the draft. When the real match exists,
  // its Match chat takes the history over (see
  // ChatService.adoptCaptainPickMatchChat).
  CaptainPickMatch = "captain_pick_match",
  // Single site-wide room, open to every verified_user+ player. Fixed id
  // "global" -- there's only ever one, see joinMatchLobby's Global case.
  Global = "global",
  // 1:1 private message. id is the two participants' steam_ids sorted
  // ascending and joined with ":" (e.g. "76561...1:76561...2") -- a
  // canonical, order-independent room id both sides derive the same way
  // without a lookup, and joinMatchLobby's Direct case parses it back out
  // to check the requesting user is actually one of the two.
  Direct = "direct",
  // Site-wide, read-only-for-everyone-but-admins channel. Fixed id
  // "announcements" -- there's only ever one, same as Global. Unlike
  // every other type here, messages are persisted in Postgres (see the
  // `announcements` table) instead of Redis's 24h-TTL hash, since the
  // whole point is that they stay readable for anyone who wasn't online
  // when one was posted.
  Announcement = "announcement",
}
