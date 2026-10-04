// Twitch Helix app credentials (client-credentials flow). Both optional:
// without them every Twitch lookup reports "unavailable" instead of failing.
export type TwitchConfig = {
  clientId?: string;
  clientSecret?: string;
};
