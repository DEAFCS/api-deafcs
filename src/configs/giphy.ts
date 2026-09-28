import { GiphyConfig } from "./types/GiphyConfig";

export default (): {
  giphy: GiphyConfig;
} => ({
  giphy: {
    apiKey: process.env.GIPHY_API_KEY,
  },
});
