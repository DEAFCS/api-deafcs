import { Injectable, Logger } from "@nestjs/common";
import { PostgresService } from "src/postgres/postgres.service";
import { MatchAssistantService } from "../match-assistant/match-assistant.service";
import { GameStreamerService } from "../game-streamer/game-streamer.service";
import { isRoleAbove } from "src/utilities/isRoleAbove";
import { e_player_roles_enum } from "generated";
import { isPreMatchRecoveryStaff } from "./pre-match-recovery-staff";

type KeyValue = string | KeyValues;
type KeyValues = Array<[string, KeyValue]>;

type Token = { type: "string" | "open" | "close"; value: string };

type MatchRow = {
  status: string;
  server_id: string | null;
  source: string | null;
  winning_lineup_id: string | null;
  lineup_1_id: string;
  lineup_2_id: string;
  type: string;
  mr: number;
  match_map_id: string | null;
  map_status: string | null;
  map_name: string | null;
  start_lineup_1_side: string | null;
  start_lineup_2_side: string | null;
};

type RoundRow = {
  round: number;
  lineup_1_score: number;
  lineup_2_score: number;
  lineup_1_side: string | null;
  lineup_2_side: string | null;
  winning_side: string | null;
  winning_reason: string | null;
  lineup_1_timeouts_available: number | null;
  lineup_2_timeouts_available: number | null;
  backup_file: string | null;
  undone: boolean;
};

export type RecoveryViewer = {
  steam_id: string;
  role: e_player_roles_enum;
};

type LineupPlayerRow = {
  steam_id: string | null;
  name: string | null;
  is_connected: boolean;
  match_lineup_id: string;
};

export type RestorePlayer = {
  steam_id: string;
  name: string;
  lineup: number;
  cash: number;
  armor: number;
  helmet: boolean;
  alive: boolean;
  weapons: Array<string>;
  kills: number;
  deaths: number;
  assists: number;
};

export type RestoreRound = {
  round: number;
  lineup_1_score: number;
  lineup_2_score: number;
  lineup_1_side: string | null;
  lineup_2_side: string | null;
  winning_side: string | null;
  winning_reason: string | null;
  lineup_1_timeouts: number | null;
  lineup_2_timeouts: number | null;
  next_lineup_1_side: string | null;
  next_lineup_2_side: string | null;
  has_backup: boolean;
  undone: boolean;
  players: Array<RestorePlayer>;
};

export type RestoreRounds = {
  match_map_id: string | null;
  map_name: string | null;
  restorable: boolean;
  blocked_reason: string | null;
  live_round: number | null;
  economy_hidden: boolean;
  connected_players: number;
  expected_players: number;
  disconnected: Array<string>;
  rounds: Array<RestoreRound>;
};

@Injectable()
export class MatchRecoveryService {
  public static readonly IN_PROGRESS_MAP_STATUSES = [
    "Warmup",
    "Knife",
    "Live",
    "Overtime",
    "Paused",
  ];

  // DEAFCS: upstream also restarts WaitingForCheckIn, Veto and Canceled
  // matches. Going back to check-in from Veto would re-run a region veto over
  // its old picks, and leaving Canceled deletes a vetoed match's maps. Those
  // are canceled and started again the usual way.
  public static readonly RESTARTABLE_STATUSES = ["WaitingForServer", "Live"];

  // The game server's MatchOptions.ExpectedPlayerCount: it refuses a restore
  // until this many players are in, and benched substitutes don't count.
  private static readonly EXPECTED_PLAYERS: Record<string, number> = {
    Rush: 6,
    Wingman: 4,
    Duel: 2,
  };

  private static readonly RESTORE_REFUSED = "restore_round refused:";

  private static readonly MATCH_STATE_REFUSED = "match_state refused:";

  private static readonly STEAM_ID_BASE = 76561197960265728n;

  private static readonly OVERTIME_MAX_ROUNDS = 6;

  constructor(
    private readonly logger: Logger,
    private readonly postgres: PostgresService,
    private readonly matchAssistant: MatchAssistantService,
    private readonly gameStreamer: GameStreamerService,
  ) {}

  public async getRestoreRounds(
    matchId: string,
    viewer: RecoveryViewer,
  ): Promise<RestoreRounds> {
    const match = await this.getMatch(matchId);
    const lineupPlayers = await this.getLineupPlayers(match);
    const affiliated = await this.isTeamAffiliated(match, viewer.steam_id);

    const result: RestoreRounds = {
      match_map_id: match.match_map_id,
      map_name: match.map_name,
      restorable: false,
      blocked_reason: this.restoreBlockedReason(match, viewer, affiliated),
      live_round: null,
      economy_hidden: false,
      connected_players: this.connectedCount(lineupPlayers),
      expected_players: this.expectedPlayers(match),
      disconnected: this.disconnectedNames(lineupPlayers),
      rounds: [],
    };

    if (!match.match_map_id || match.type === "Rush") {
      return result;
    }

    const inProgress = MatchRecoveryService.IN_PROGRESS_MAP_STATUSES.includes(
      match.map_status ?? "",
    );

    // DEAFCS: players' money, weapons and equipment only ever reach an
    // administrator who isn't playing in the match. Upstream hides them only
    // from someone on one of the teams while the map is being played.
    result.economy_hidden = this.economyHidden(viewer, affiliated);

    const rows = await this.getRounds(match.match_map_id);
    const lineupBySteamId = new Map(
      lineupPlayers
        .filter((player) => player.steam_id)
        .map((player) => [
          player.steam_id as string,
          player.match_lineup_id === match.lineup_1_id ? 1 : 2,
        ]),
    );

    result.rounds = rows.map((row, index) => {
      const next = rows[index + 1];
      const hasBackup = !!row.backup_file;

      return {
        round: row.round,
        lineup_1_score: row.lineup_1_score,
        lineup_2_score: row.lineup_2_score,
        lineup_1_side: row.lineup_1_side,
        lineup_2_side: row.lineup_2_side,
        winning_side: row.winning_side,
        winning_reason: row.winning_reason,
        lineup_1_timeouts: row.lineup_1_timeouts_available,
        lineup_2_timeouts: row.lineup_2_timeouts_available,
        next_lineup_1_side:
          next?.lineup_1_side ??
          this.sideForRound(match.start_lineup_1_side, row.round, match),
        next_lineup_2_side:
          next?.lineup_2_side ??
          this.sideForRound(match.start_lineup_2_side, row.round, match),
        has_backup: hasBackup,
        undone: row.undone,
        players:
          hasBackup && !result.economy_hidden
            ? this.backupPlayers(row.backup_file as string, lineupBySteamId)
            : [],
      };
    });

    // Rounds a reset undid stay listed, and restorable, until the next round
    // is played and ScoreEvent removes them.
    if (inProgress) {
      result.live_round =
        (rows.filter((row) => !row.undone).at(-1)?.round ?? 0) + 1;
      result.restorable = rows.some((row) => !!row.backup_file);
    }

    return result;
  }

  // `round` is the backup to load: the last round that stays played. Loading
  // round N's backup starts round N + 1.
  public async restoreRound(
    matchId: string,
    round: number,
    viewer: RecoveryViewer,
  ) {
    const match = await this.getMatch(matchId);

    const blockedReason = this.restoreBlockedReason(
      match,
      viewer,
      await this.isTeamAffiliated(match, viewer.steam_id),
    );
    if (blockedReason === "rush") {
      throw Error("Rush matches can't restore rounds");
    }

    if (blockedReason === "not_in_progress") {
      throw Error("there is no map in progress to restore");
    }

    if (blockedReason === "team_member") {
      throw Error(
        "organizers on one of the teams can't restore rounds; players can still call the in-game vote",
      );
    }

    if (blockedReason === "not_live_yet") {
      throw Error("the map isn't live yet; restore once it is");
    }

    const rows = await this.getRounds(match.match_map_id as string);
    if (!rows.some((row) => row.round === round && !!row.backup_file)) {
      throw Error(`round ${round} has no backup to restore`);
    }

    const lineupPlayers = await this.getLineupPlayers(match);
    const connected = this.connectedCount(lineupPlayers);
    const expected = this.expectedPlayers(match);
    if (connected < expected) {
      throw Error(
        `waiting for players to reconnect (${connected}/${expected}): ${this.disconnectedNames(lineupPlayers).join(", ")}`,
      );
    }

    const response = await this.matchAssistant.requestRoundRestore(
      matchId,
      round,
    );
    if (response === undefined) {
      throw Error("the match server can't be reached");
    }

    const refusal = this.serverRefusal(
      response,
      MatchRecoveryService.RESTORE_REFUSED,
    );
    if (refusal) {
      throw Error(refusal);
    }

    this.logger.log(
      `[${matchId}] organizer requested a restore to round ${round} ${this.actor(viewer)}`,
    );

    return { success: true };
  }

  // Back to check-in on a new server. A map that was still being played is put
  // back to the start (its rounds only soft-deleted), or the next server would
  // offer to restore its old rounds.
  //
  // DEAFCS: one status change, straight to WaitingForCheckIn. Upstream goes
  // through Canceled, and leaving Canceled clears a map veto by deleting every
  // map: a finished map's stats go with it, a map with a demo fails the whole
  // restart, and the two match_events (Canceled, then WaitingForCheckIn) can be
  // handled in either order. Without the Canceled step the veto, the maps, the
  // finished maps' stats and demos stay, and no Canceled side effect runs (no
  // ELO run, no matchmaking or Discord cleanup). What Canceled did that a
  // restart still needs is done here: the on-demand server drains like an
  // ended match's (tau_matches), and the livestream stops.
  public async restartMatch(matchId: string, viewer: RecoveryViewer) {
    const match = await this.getMatch(matchId);

    if (match.source && match.source !== "5stack") {
      throw Error("only matches played on 5stack servers can be restarted");
    }

    if (!MatchRecoveryService.RESTARTABLE_STATUSES.includes(match.status)) {
      throw Error(`a ${match.status} match can't be restarted`);
    }

    let serverId: string | null = null;

    await this.postgres.transaction(async (client) => {
      // The match can end or change server while this runs.
      const {
        rows: [locked],
      } = await client.query<{ status: string; server_id: string | null }>(
        "SELECT status, server_id::text AS server_id FROM matches WHERE id = $1 FOR UPDATE",
        [matchId],
      );

      if (
        !locked ||
        !MatchRecoveryService.RESTARTABLE_STATUSES.includes(locked.status)
      ) {
        throw Error(
          `a ${locked?.status ?? "missing"} match can't be restarted`,
        );
      }

      serverId = locked.server_id;

      const { rows: maps } = await client.query<{ id: string }>(
        `SELECT id FROM match_maps WHERE match_id = $1 AND status = ANY($2)`,
        [matchId, MatchRecoveryService.IN_PROGRESS_MAP_STATUSES],
      );
      for (const map of maps) {
        await client.query("SELECT reset_match_map_to_round($1, 0)", [map.id]);
      }

      if (maps.length > 0) {
        await client.query(
          `UPDATE match_maps SET status = 'Scheduled', started_at = NULL
            WHERE id = ANY($1)`,
          [maps.map((map) => map.id)],
        );
      }

      // tau_matches' Canceled case: the old pod is stopped at once (match_events
      // sees the server removed), and the server goes back into rotation only
      // once the pod is gone (reconcileDrainingOnDemandServers). Only the
      // server in server_id: one an assignment still in flight has reserved
      // keeps its reservation, so the server_id it writes next stays valid.
      await client.query(
        `UPDATE servers
            SET reserved_by_match_id = NULL,
                draining_match_id = CASE WHEN is_dedicated OR type != 'Ranked'
                    THEN draining_match_id ELSE $1 END,
                draining_check_at = CASE WHEN is_dedicated OR type != 'Ranked'
                    THEN draining_check_at ELSE now() END
          WHERE id = $2
            AND reserved_by_match_id = $1`,
        [matchId, serverId],
      );

      // Only auto-cancel re-arms cancels_at on the way back to check-in.
      // Dropping the server frees its reservation, so the get_match below
      // tells a dedicated server to drop the old game.
      await client.query(
        `UPDATE matches
            SET status = 'WaitingForCheckIn', server_id = NULL, cancels_at = NULL
          WHERE id = $1`,
        [matchId],
      );
    });

    if (serverId) {
      await this.matchAssistant.refreshServerMatch(serverId);
    }

    try {
      await this.gameStreamer.stopLiveIfRunning(matchId);
    } catch (error) {
      this.logger.warn(
        `[${matchId}] unable to stop the livestream after a restart: ${(error as Error)?.message}`,
      );
    }

    this.logger.log(
      `[${matchId}] restarted the match from check-in ${this.actor(viewer)}`,
    );

    return { success: true };
  }

  // Back to warmup on the map being played. Its rounds and stats are only
  // soft-deleted, so a restore can still bring any of them back until a round
  // is played again. The server is told first: if it can't be reached, nothing
  // has been touched.
  public async restartMatchMap(matchId: string, viewer: RecoveryViewer) {
    const match = await this.getMatch(matchId);

    const blockedReason = this.mapControlBlockedReason(
      match,
      viewer,
      await this.isTeamAffiliated(match, viewer.steam_id),
    );
    if (blockedReason === "not_in_progress") {
      throw Error("there is no map in progress to restart");
    }

    if (blockedReason === "team_member") {
      throw Error("organizers on one of the teams can't restart the map");
    }

    const response = await this.matchAssistant.restartServerMap(matchId);
    if (response === undefined) {
      throw Error("the match server can't be reached");
    }

    const refusal = this.serverRefusal(
      response,
      MatchRecoveryService.MATCH_STATE_REFUSED,
    );
    if (refusal) {
      throw Error(refusal);
    }

    await this.postgres.query("SELECT reset_match_map_to_round($1, 0)", [
      match.match_map_id,
    ]);

    this.logger.log(
      `[${matchId}] organizer restarted map ${match.match_map_id} from warmup ${this.actor(viewer)}`,
    );

    return { success: true };
  }

  // A veto rewound after a server was booted releases it; a dedicated server
  // keeps running, so it is told to reload and drop the old maps.
  //
  // DEAFCS: Reset Veto only, i.e. upstream's Redo the Veto (step 1). Undo the
  // Last Step and Fix a Mis-pick (later steps) are not offered, and Give 30s
  // More (extendVetoClock) is not ported.
  public async rewindMapVeto(
    matchId: string,
    step: number,
    expectedPicks: number | undefined,
    viewer: RecoveryViewer,
  ) {
    if (!(await isPreMatchRecoveryStaff(this.postgres, matchId, viewer))) {
      throw Error("only staff can reset the veto");
    }

    if (step !== 1) {
      throw Error("only the whole veto can be reset");
    }

    const [{ server_id }] = await this.postgres.query<
      Array<{ server_id: string | null }>
    >("SELECT rewind_map_veto($1, $2, $3)::text AS server_id", [
      matchId,
      step,
      expectedPicks ?? null,
    ]);

    if (server_id) {
      await this.matchAssistant.refreshServerMatch(server_id);
    }

    this.logger.log(
      `[${matchId}] organizer reset the veto ${this.actor(viewer)}`,
    );

    return { success: true };
  }

  // DEAFCS: Pause and Resume as a predefined action, so organizers never need
  // the RCON console. The plugin takes a console pause as an admin pause.
  public async setMatchPaused(
    matchId: string,
    paused: boolean,
    viewer: RecoveryViewer,
  ) {
    const match = await this.getMatch(matchId);

    const blockedReason = this.mapControlBlockedReason(
      match,
      viewer,
      await this.isTeamAffiliated(match, viewer.steam_id),
    );
    if (blockedReason === "team_member") {
      throw Error(
        "organizers on one of the teams can't pause or resume the match",
      );
    }

    const allowed = paused ? ["Live", "Overtime"] : ["Paused"];
    if (blockedReason || !allowed.includes(match.map_status ?? "")) {
      throw Error(
        paused ? "there is no live map to pause" : "the map isn't paused",
      );
    }

    const response = await this.matchAssistant.setServerPaused(matchId, paused);
    if (response === undefined) {
      throw Error("the match server can't be reached");
    }

    this.logger.log(
      `[${matchId}] organizer ${paused ? "paused" : "resumed"} map ${match.match_map_id} ${this.actor(viewer)}`,
    );

    return { success: true };
  }

  public parseKeyValues(text: string): KeyValues {
    const tokens = this.tokenize(text);
    let index = 0;

    const readNode = (): KeyValues => {
      const node: KeyValues = [];
      while (index < tokens.length) {
        const token = tokens[index++];
        if (token.type === "close") {
          return node;
        }
        if (token.type === "open") {
          continue;
        }

        const next = tokens[index];
        if (next?.type === "open") {
          index++;
          node.push([token.value, readNode()]);
          continue;
        }

        index++;
        node.push([token.value, next?.type === "string" ? next.value : ""]);
      }
      return node;
    };

    return readNode();
  }

  private tokenize(text: string): Array<Token> {
    const tokens: Array<Token> = [];
    let i = 0;

    while (i < text.length) {
      const char = text[i];

      if (/\s/.test(char)) {
        i++;
        continue;
      }

      if (char === "/" && text[i + 1] === "/") {
        while (i < text.length && text[i] !== "\n") {
          i++;
        }
        continue;
      }

      if (char === "{" || char === "}") {
        tokens.push({ type: char === "{" ? "open" : "close", value: char });
        i++;
        continue;
      }

      if (char === '"') {
        let value = "";
        i++;
        while (i < text.length && text[i] !== '"') {
          // A player name can end in a backslash, so a quote after one still
          // closes the string when whitespace, a brace or the end follows it.
          if (text[i] === "\\" && text[i + 1] === '"') {
            const after = text[i + 2];
            if (after === undefined || /[\s{}]/.test(after)) {
              value += "\\";
              i++;
              continue;
            }
            value += '"';
            i += 2;
            continue;
          }
          if (text[i] === "\\" && text[i + 1] === "\\") {
            value += "\\";
            i += 2;
            continue;
          }
          value += text[i];
          i++;
        }
        i++;
        tokens.push({ type: "string", value });
        continue;
      }

      let value = "";
      while (i < text.length && !/[\s{}"]/.test(text[i])) {
        value += text[i];
        i++;
      }
      tokens.push({ type: "string", value });
    }

    return tokens;
  }

  private child(node: KeyValues | undefined, key: string) {
    return node?.find(
      ([name]) => name.toLowerCase() === key.toLowerCase(),
    )?.[1];
  }

  private childNode(node: KeyValues | undefined, key: string) {
    const value = this.child(node, key);
    return Array.isArray(value) ? value : undefined;
  }

  private childNumber(node: KeyValues | undefined, key: string) {
    const value = Number(this.child(node, key));
    return Number.isFinite(value) ? value : 0;
  }

  private backupPlayers(
    backupFile: string,
    lineupBySteamId: Map<string, number>,
  ): Array<RestorePlayer> {
    const save = this.childNode(this.parseKeyValues(backupFile), "SaveFile");
    const players: Array<RestorePlayer> = [];

    for (const team of ["PlayersOnTeam1", "PlayersOnTeam2"]) {
      for (const [accountId, value] of this.childNode(save, team) ?? []) {
        if (!Array.isArray(value) || !/^\d+$/.test(accountId)) {
          continue;
        }

        const steamId = (
          BigInt(accountId) + MatchRecoveryService.STEAM_ID_BASE
        ).toString();
        const weapons = (this.childNode(value, "Items") ?? [])
          .map(([, item]) => (typeof item === "string" ? item : ""))
          .filter(
            (item) =>
              item &&
              !item.startsWith("weapon_knife") &&
              item !== "weapon_bayonet",
          );

        players.push({
          steam_id: steamId,
          name: String(this.child(value, "name") ?? ""),
          lineup: lineupBySteamId.get(steamId) ?? 0,
          cash: this.childNumber(value, "cash"),
          armor: this.childNumber(value, "armor"),
          helmet: this.child(value, "helmet") === "1",
          alive: !!this.childNode(value, "Items"),
          weapons,
          kills: this.childNumber(value, "kills"),
          deaths: this.childNumber(value, "deaths"),
          assists: this.childNumber(value, "assists"),
        });
      }
    }

    return players;
  }

  // Mirrors the game server's TeamUtility.GetLineupSide: `roundIndex` counts
  // rounds already played, overtime switches every half of
  // mp_overtime_maxrounds.
  private sideForRound(
    startSide: string | null,
    roundIndex: number,
    match: MatchRow,
  ): string | null {
    const mr = Number(match.mr);
    if (!startSide || mr <= 0 || match.type === "Rush") {
      return startSide;
    }

    const opposite = startSide === "CT" ? "TERRORIST" : "CT";

    if (roundIndex < mr * 2) {
      return roundIndex < mr ? startSide : opposite;
    }

    const overtimeMr = MatchRecoveryService.OVERTIME_MAX_ROUNDS;
    const overtimeRound = roundIndex - mr * 2;
    const overtimeNumber = Math.floor(overtimeRound / overtimeMr) + 1;
    const block = overtimeRound % overtimeMr;

    return (
      overtimeNumber % 2 === 1
        ? block < overtimeMr / 2
        : block >= overtimeMr / 2
    )
      ? opposite
      : startSide;
  }

  private restoreBlockedReason(
    match: MatchRow,
    viewer: RecoveryViewer,
    affiliated: boolean,
  ): string | null {
    if (match.type === "Rush") {
      return "rush";
    }

    const blockedReason = this.mapControlBlockedReason(
      match,
      viewer,
      affiliated,
    );
    if (blockedReason) {
      return blockedReason;
    }

    // CS2 restarts the game when warmup or knife ends, which would wipe a
    // round loaded before that. A restarted map's rounds stay restorable
    // until its first round is over.
    if (match.map_status === "Warmup" || match.map_status === "Knife") {
      return "not_live_yet";
    }

    return null;
  }

  private serverRefusal(response: string, prefix: string) {
    const refused = response.indexOf(prefix);
    if (refused === -1) {
      return null;
    }

    return response
      .slice(refused + prefix.length)
      .trim()
      .split("\n")[0];
  }

  private mapControlBlockedReason(
    match: MatchRow,
    viewer: RecoveryViewer,
    affiliated: boolean,
  ): string | null {
    if (
      match.status !== "Live" ||
      !MatchRecoveryService.IN_PROGRESS_MAP_STATUSES.includes(
        match.map_status ?? "",
      )
    ) {
      return "not_in_progress";
    }

    // The in-game reset needs both teams to vote for it; an organizer who is on
    // one of them would skip that vote. DEAFCS: match organizers, tournament
    // organizers and administrators may, where upstream lets moderators and
    // above. They still never see the economy (economyHidden).
    if (affiliated && !isRoleAbove(viewer.role, "match_organizer")) {
      return "team_member";
    }

    return null;
  }

  private economyHidden(viewer: RecoveryViewer, affiliated: boolean) {
    return affiliated || !isRoleAbove(viewer.role, "administrator");
  }

  private actor(viewer: RecoveryViewer) {
    return `(by ${viewer.steam_id}, ${viewer.role})`;
  }

  private expectedPlayers(match: MatchRow) {
    return MatchRecoveryService.EXPECTED_PLAYERS[match.type] ?? 10;
  }

  private connectedCount(players: Array<LineupPlayerRow>) {
    return players.filter((player) => player.steam_id && player.is_connected)
      .length;
  }

  private async isTeamAffiliated(match: MatchRow, steamId: string) {
    const [row] = await this.postgres.query<Array<{ affiliated: boolean }>>(
      `SELECT EXISTS (
                SELECT 1 FROM match_lineup_players mlp
                 WHERE mlp.match_lineup_id IN ($1, $2)
                   AND mlp.steam_id = $3
              )
              OR EXISTS (
                SELECT 1 FROM match_lineups ml
                 WHERE ml.id IN ($1, $2)
                   AND ml.coach_steam_id = $3
              )
              OR EXISTS (
                SELECT 1 FROM match_lineups ml
                  JOIN team_roster tr ON tr.team_id = ml.team_id
                 WHERE ml.id IN ($1, $2)
                   AND tr.player_steam_id = $3
                   AND tr.role <> 'Pending'
              ) AS affiliated`,
      [match.lineup_1_id, match.lineup_2_id, steamId],
    );

    return !!row?.affiliated;
  }

  private disconnectedNames(players: Array<LineupPlayerRow>) {
    return players
      .filter((player) => player.steam_id && !player.is_connected)
      .map((player) => player.name || (player.steam_id as string));
  }

  private async getMatch(matchId: string): Promise<MatchRow> {
    const [match] = await this.postgres.query<Array<MatchRow>>(
      `SELECT m.status, m.source, m.server_id::text AS server_id,
              m.winning_lineup_id::text AS winning_lineup_id,
              m.lineup_1_id::text AS lineup_1_id, m.lineup_2_id::text AS lineup_2_id,
              mo.type, mo.mr,
              mm.id::text AS match_map_id, mm.status AS map_status,
              mm.lineup_1_side AS start_lineup_1_side,
              mm.lineup_2_side AS start_lineup_2_side,
              mp.name AS map_name
         FROM matches m
         JOIN match_options mo ON mo.id = m.match_options_id
         LEFT JOIN match_maps mm ON mm.id = get_current_match_map(m)
         LEFT JOIN maps mp ON mp.id = mm.map_id
        WHERE m.id = $1`,
      [matchId],
    );

    if (!match) {
      throw Error("match not found");
    }

    return match;
  }

  private getRounds(matchMapId: string) {
    return this.postgres.query<Array<RoundRow>>(
      `SELECT round, lineup_1_score, lineup_2_score, lineup_1_side, lineup_2_side,
              winning_side, winning_reason,
              lineup_1_timeouts_available, lineup_2_timeouts_available,
              backup_file, deleted_at IS NOT NULL AS undone
         FROM match_map_rounds
        WHERE match_map_id = $1
          AND round > 0
        ORDER BY round`,
      [matchMapId],
    );
  }

  private getLineupPlayers(match: MatchRow) {
    return this.postgres.query<Array<LineupPlayerRow>>(
      `SELECT mlp.steam_id::text AS steam_id,
              COALESCE(p.name, mlp.placeholder_name) AS name,
              mlp.is_connected,
              mlp.match_lineup_id::text AS match_lineup_id
         FROM match_lineup_players mlp
         LEFT JOIN players p ON p.steam_id = mlp.steam_id
        WHERE mlp.match_lineup_id IN ($1, $2)
        ORDER BY mlp.match_lineup_id, name`,
      [match.lineup_1_id, match.lineup_2_id],
    );
  }
}
