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
  UtilityLibraryEnabled = "public.utility_library_enabled",
  UtilityPracticeEnabled = "public.utility_practice_enabled",
  // Minutes an empty practice server is kept alive before the reaper stops it.
  UtilityPracticeIdleMinutes = "public.utility_practice_idle_minutes",
  UtilityPracticeConnectMinutes = "public.utility_practice_connect_minutes",
  UtilityPracticeMaxMinutes = "public.utility_practice_max_minutes",
  // Minutes a queue entry means anything. Nothing serves the waitlist -- it is
  // only ever cleared by the same player getting a server -- so an unbounded
  // one lets a player who tried once and walked away hold every other session
  // under the max-length clock indefinitely.
  UtilityPracticeWaitlistMinutes = "public.utility_practice_waitlist_minutes",
  // On-demand server slots a practice session will never take. Without it a
  // player idly practising can consume the last slot a scheduled tournament
  // match was going to boot into.
  UtilityPracticeReservedServers = "public.utility_practice_reserved_servers",
  UtilityLineupDailyLimit = "public.utility_lineup_daily_limit",
  // Source units a throw may miss the lineup's landing point by and still
  // count. A CS2 smoke's radius is about 144 units, so the default of 96 is
  // "the cloud still covers what the lineup was for", not "close enough".
  UtilitySuccessRadius = "public.utility_success_radius",
  // Distinct players who must have mastered a lineup before it verifies itself.
  // Read by taiu_utility_lineup_progress_verify, not by any TypeScript: the
  // derivation is a trigger, so this name exists here only to be discoverable
  // alongside the rest.
  UtilityVerifyMasteries = "public.utility_verify_masteries",
  UtilitySolvesPerHour = "public.utility_solves_per_hour",
  UtilityDiscoveriesPerHour = "public.utility_discoveries_per_hour",
  // Off by default. The seeder writes lineups nobody threw on this platform, so
  // it is an operator's deliberate act rather than a door that is always open.
  UtilityImportEnabled = "public.utility_import_enabled",
  GameServerPluginRuntime = "public.game_server_plugin_runtime",
  GameServerPluginRuntimeLocked = "game_server_plugin_runtime_locked",
  CreateAwardsRole = "public.create_awards_role",
  GrantAwardsRole = "public.grant_awards_role",
  // Off until the map-assets worker is deployed: a build published before the
  // CDN can serve it would point latest.json at files nothing can read. Gates
  // the build a new CS2 version triggers, never the manual action.
  MapAssetsAutoBuild = "map_assets_auto_build",
}
