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
}
