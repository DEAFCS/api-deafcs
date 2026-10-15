export enum SystemSettingName {
  Updates = "updates",
  ChatMessageTtl = "chat_message_ttl",
  DemoNetworkLimiter = "demo_network_limiter",
  PublicDefaultModels = "public.default_models",
  SupportsDiscordBot = "public.supports_discord_bot",
  SupportsGameServerNodes = "supports_game_server_nodes",
  SupportsGameServerVersionPinning = "supports_game_server_version_pinning",
  EventsEnabled = "public.events_enabled",
  NewsEnabled = "public.news_enabled",
  NewsLabel = "public.news_label",
  PostNewsRole = "public.post_news_role",
  RequireLoginForLiveStreams = "public.require_login_for_live_streams",
  LeaguesEnabled = "public.leagues_enabled",
  GameServerPluginRuntime = "public.game_server_plugin_runtime",
  GameServerPluginRuntimeLocked = "game_server_plugin_runtime_locked",
  CreateAwardsRole = "public.create_awards_role",
  GrantAwardsRole = "public.grant_awards_role",
  // Off until the map-assets worker is deployed: a build published before the
  // CDN can serve it would point latest.json at files nothing can read. Gates
  // the build a new CS2 version triggers, never the manual action.
  MapAssetsAutoBuild = "map_assets_auto_build",
}
