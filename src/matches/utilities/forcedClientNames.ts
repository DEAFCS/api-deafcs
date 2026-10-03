// Valve's sv_load_forced_client_names_file is KeyValues:
//   "Names" { "<SteamID64>" "<name>" }
// Names that could break out of a quoted string (or a line) are skipped
// rather than escaped, so one odd name can never corrupt the whole file.
export function isSafeForcedClientName(name: string | null | undefined) {
  return !!name && name.trim().length > 0 && !/["\\\r\n]/.test(name);
}

export function buildForcedClientNamesFile(
  players: Array<{ steam_id: string; name: string | null }>,
): string {
  const lines = players
    .filter(
      (player) =>
        /^\d{17}$/.test(String(player.steam_id)) &&
        isSafeForcedClientName(player.name),
    )
    .map((player) => `\t"${player.steam_id}"\t"${player.name}"`);

  return `"Names"\n{\n${lines.join("\n")}${lines.length ? "\n" : ""}}\n`;
}
