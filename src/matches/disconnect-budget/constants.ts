// Reserved player row (see migration 1877000000000_seed_system_player) used
// as the sanctioner for bans issued automatically rather than by an admin.
//
// Deliberately its own file with zero imports -- SYSTEM_STEAM_ID used to
// live in disconnect-budget.service.ts, but importing it from there pulled
// in that module's own dependency chain (SanctionsService -> RconService ->
// NotificationsService) into every other file that just wanted the
// constant, closing a circular import back through NotificationsService and
// crashing Nest's DI at boot ("Nest can't resolve dependencies of
// DedicatedServersService... argument at index [4]").
export const SYSTEM_STEAM_ID = "0";
