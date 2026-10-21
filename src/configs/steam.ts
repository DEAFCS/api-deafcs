import { SteamConfig } from "./types/SteamConfig";

export default (): {
  steam: SteamConfig;
} => ({
  steam: {
    steamApiKey: process.env.STEAM_WEB_API_KEY,
    steamUser: process.env.STEAM_USER,
    steamPassword: process.env.STEAM_PASSWORD,
    // DEAFCS: Steam GC has its own account. STEAM_USER is the livestream
    // (DEAFCS Streamer) account and is never used for the GC.
    steamGcSteamId64: process.env.STEAM_GC_STEAMID64,
    steamGcUser: process.env.STEAM_GC_USER,
    steamGcPassword: process.env.STEAM_GC_PASSWORD,
  },
});
