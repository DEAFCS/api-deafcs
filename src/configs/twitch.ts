import { TwitchConfig } from "./types/TwitchConfig";

export default (): {
  twitch: TwitchConfig;
} => ({
  twitch: {
    clientId: process.env.TWITCH_CLIENT_ID,
    clientSecret: process.env.TWITCH_CLIENT_SECRET,
  },
});
