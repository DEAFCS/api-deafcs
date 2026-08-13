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
  // Single site-wide room, open to every verified_user+ player. Fixed id
  // "global" -- there's only ever one, see joinMatchLobby's Global case.
  Global = "global",
  // 1:1 private message. id is the two participants' steam_ids sorted
  // ascending and joined with ":" (e.g. "76561...1:76561...2") -- a
  // canonical, order-independent room id both sides derive the same way
  // without a lookup, and joinMatchLobby's Direct case parses it back out
  // to check the requesting user is actually one of the two.
  Direct = "direct",
}
