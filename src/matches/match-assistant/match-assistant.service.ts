import { Injectable, Logger } from "@nestjs/common";
import { HasuraService } from "../../hasura/hasura.service";
import { PluginRuntimeService } from "src/plugin-runtime/plugin-runtime.service";
import {
  BatchV1Api,
  CoreV1Api,
  KubeConfig,
  Exec,
  V1Job,
  V1Pod,
} from "@kubernetes/client-node";
import { RconService } from "../../rcon/rcon.service";
import { User } from "../../auth/types/User";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { MatchQueues } from "../enums/MatchQueues";
import { MatchJobs } from "../enums/MatchJobs";
import { ConfigService } from "@nestjs/config";
import { GameServersConfig } from "../../configs/types/GameServersConfig";
import {
  e_map_pool_types_enum,
  e_match_map_status_enum,
  e_match_status_enum,
  e_match_types_enum,
  e_timeout_settings_enum,
  servers_bool_exp,
} from "../../../generated";
import { CacheService } from "../../cache/cache.service";
import { EncryptionService } from "../../encryption/encryption.service";
import { AppConfig } from "src/configs/types/AppConfig";
import { FailedToCreateOnDemandServer } from "../errors/FailedToCreateOnDemandServer";
import { LoggingService } from "src/k8s/logging/logging.service";
import { PostgresService } from "src/postgres/postgres.service";
import type { MatchServerBootDiagnostic } from "src/k8s/logging/bootDiagnostics";

@Injectable()
export class MatchAssistantService {
  private appConfig: AppConfig;
  private gameServerConfig: GameServersConfig;

  private readonly namespace: string;
  // Jobs created before the match labels only match by name, so the sweep lists everything until none is left.
  // DEAFCS does not label its server Jobs yet, so it always lists every Job in the namespace.
  private unlabelledServerJobsRemain = true;
  private static readonly REBOOTABLE_ON_DEMAND_STATUSES: readonly e_match_status_enum[] =
    [
      "Scheduled",
      "WaitingForCheckIn",
      "WaitingForServer",
      "Veto",
      "PickingPlayers",
      "Live",
    ];
  private static readonly TERMINAL_MATCH_STATUSES: readonly e_match_status_enum[] =
    ["Finished", "Canceled", "Forfeit", "Tie", "Surrendered"];
  private static readonly DRAFT_CANCELLABLE_STATUSES: readonly e_match_status_enum[] =
    [
      "Scheduled",
      "WaitingForCheckIn",
      "WaitingForServer",
      "Veto",
      "PickingPlayers",
    ];
  // Sources only the on-demand image can run. The utility practice plugin ships
  // in that image and not in the dedicated one, so a dedicated server handed to
  // one of these is worse than failing: the connect string resolves the moment
  // the server is assigned, so the website reads "ready to join" for a box that
  // will never answer GET /utility/session and never comes up as a practice
  // server at all.
  //
  // Not the same rule as the `source === "practice"` branch in match_events,
  // which is about skipping Discord, ELO and the rest -- a source can want one
  // without the other.
  private static readonly ON_DEMAND_ONLY_SOURCES: ReadonlyArray<string> = [
    "practice",
  ];
  public static readonly ON_DEMAND_SERVER_BOOT_CHECK_DELAY_MS = 15 * 1000;
  public static readonly ON_DEMAND_SERVER_STOP_CHECK_DELAY_MS = 2 * 60 * 1000;
  private static readonly ORPHANED_JOB_CREATE_GRACE_MS = 5 * 60 * 1000;
  private static readonly ORPHANED_JOB_UNASSIGNED_GRACE_MS = 5 * 60 * 1000;
  private static readonly ORPHANED_JOB_ENDED_GRACE_MS = 10 * 60 * 1000;
  // DEAFCS: a bad read must not empty the cluster in one sweep; the rest wait a minute.
  private static readonly ORPHANED_JOB_MAX_REMOVALS_PER_SWEEP = 3;
  private static readonly MATCH_SERVER_JOB_SELECTOR =
    "app=game-server,role=match";
  private static readonly MATCH_SERVER_JOB_NAME =
    /^m-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
  private static readonly UUID =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  private static readonly INITIAL_BOOT_STATUS_DETAIL =
    "Waiting for Kubernetes to create the match server pod.";

  constructor(
    private readonly logger: Logger,
    private readonly rcon: RconService,
    private readonly cache: CacheService,
    private readonly config: ConfigService,
    private readonly hasura: HasuraService,
    private readonly encryption: EncryptionService,
    private readonly loggingService: LoggingService,
    private readonly pluginRuntimeService: PluginRuntimeService,
    @InjectQueue(MatchQueues.MatchServers) private queue: Queue,
    private readonly postgres: PostgresService,
    @InjectQueue(MatchQueues.ScheduledMatches)
    private scheduledMatchesQueue: Queue,
  ) {
    this.appConfig = this.config.get<AppConfig>("app");
    this.gameServerConfig = this.config.get<GameServersConfig>("gameServers");
    this.namespace = this.gameServerConfig.namespace;
  }

  // u- = utility practice and render servers, m- = every other match.
  public static GetMatchServerJobId(matchId: string, source?: string) {
    return `${source === "practice" ? "u" : "m"}-${matchId}`;
  }

  public async sendServerMatchId(matchId: string) {
    try {
      await this.command(matchId, `get_match`);
    } catch (error) {
      this.logger.warn(
        `[${matchId}] unable to send match to server`,
        error.message,
      );
    }
  }

  public async restoreMatchRound(matchId: string, round: number) {
    try {
      this.logger.log(
        `[${matchId}] sending api_restore_round ${round} to server`,
      );
      const response = await this.command(
        matchId,
        `api_restore_round ${round}`,
      );
      this.logger.log(
        `[${matchId}] api_restore_round ${round} response: ${response ?? "<no response>"}`,
      );
    } catch (error) {
      this.logger.warn(
        `[${matchId}] unable to send restore round to server`,
        error.message,
      );
    }
  }

  public async resetMatchMapToRound(matchMapId: string, round: number) {
    await this.postgres.query("SELECT reset_match_map_to_round($1, $2)", [
      matchMapId,
      round,
    ]);
  }

  public async restartServerMap(matchId: string) {
    return await this.command(matchId, "match_state Warmup");
  }

  public async requestRoundRestore(matchId: string, round: number) {
    return await this.command(matchId, `restore_round ${round}`);
  }

  // A server no longer reserved for the match gets nothing back from
  // current-match, so the plugin drops whatever game it still has loaded.
  public async refreshServerMatch(serverId: string) {
    try {
      const rcon = await this.rcon.connect(serverId);
      await rcon?.send("get_match");
    } catch (error) {
      this.logger.warn(
        `[${serverId}] unable to tell the server to reload its match`,
        error.message,
      );
    }
  }

  public async knifeSwitch(matchId: string) {
    try {
      await this.command(matchId, `api_knife_switch`);
    } catch (error) {
      this.logger.warn(
        `[${matchId}] unable to send knife switch to the server`,
        error.message,
      );
    }
  }

  // A practice server runs the utility practice plugin instead of the match
  // plugin, so `get_match` is not a command it knows. This is the equivalent:
  // re-read the roster that decides who is allowed to connect.
  public async sendUtilityPracticeRefresh(matchId: string) {
    try {
      await this.command(matchId, `utility_practice_refresh`);
    } catch (error) {
      this.logger.warn(
        `[${matchId}] unable to refresh the utility practice roster`,
        error.message,
      );
    }
  }

  // Whether a pod could be booted here at all, as opposed to whether one is
  // free right now. countFreeOnDemandServers answers zero for both, and telling
  // them apart is what keeps a player queuing for a server no node could ever
  // provide. Same node predicate assignOnDemandServer runs before it takes the
  // pool lock.
  public async hasOnDemandNodes(region?: string | null): Promise<boolean> {
    const { game_server_nodes } = await this.hasura.query({
      game_server_nodes: {
        __args: {
          where: {
            status: {
              _eq: "Online",
            },
            enabled: {
              _eq: true,
            },
            enabled_for_match_making: {
              _eq: true,
            },
            ...(region
              ? {
                  region: {
                    _eq: region,
                  },
                }
              : {}),
          },
          limit: 1,
        },
        id: true,
      },
    });

    return game_server_nodes.length > 0;
  }

  // The nodes here that could boot a practice server. Practice runs the
  // SwiftlyS2 plugin whatever runtime matches use, so a node is only one of
  // them while SwiftlyS2 supports its CS2 build.
  public async practiceNodeIds(region?: string | null): Promise<Array<string>> {
    const { game_server_nodes } = await this.hasura.query({
      game_server_nodes: {
        __args: {
          where: {
            status: {
              _eq: "Online",
            },
            enabled: {
              _eq: true,
            },
            enabled_for_match_making: {
              _eq: true,
            },
            ...(region
              ? {
                  region: {
                    _eq: region,
                  },
                }
              : {}),
          },
        },
        id: true,
        build_id: true,
        pin_plugin_version: true,
        pin_plugin_runtime: true,
      },
    });

    const supported = await Promise.all(
      game_server_nodes.map((node) =>
        this.pluginRuntimeService.supportsPractice(node),
      ),
    );

    return game_server_nodes
      .filter((_, index) => supported[index])
      .map((node) => node.id);
  }

  // The same set assignOnDemandServer picks from, counted rather than taken.
  // Anything that wants to know whether there is room to boot another server
  // has to ask with this exact predicate, or it will promise a slot that the
  // assignment then cannot find.
  public async countFreeOnDemandServers(region?: string | null) {
    const { servers_aggregate } = await this.hasura.query({
      servers_aggregate: {
        __args: {
          where: {
            type: {
              _eq: "Ranked",
            },
            enabled: {
              _eq: true,
            },
            is_dedicated: {
              _eq: false,
            },
            reserved_by_match_id: {
              _is_null: true,
            },
            ...MatchAssistantService.pendingDemoUploadExclusion(),
            game_server_node: {
              _and: [
                {
                  enabled: {
                    _eq: true,
                  },
                  enabled_for_match_making: {
                    _eq: true,
                  },
                  status: {
                    _eq: "Online",
                  },
                },
                ...(region
                  ? [
                      {
                        region: {
                          _eq: region,
                        },
                      },
                    ]
                  : []),
              ],
            },
          },
        },
        aggregate: {
          count: true,
        },
      },
    });

    return servers_aggregate?.aggregate?.count ?? 0;
  }
  public async getMatchLineups(matchId: string) {
    const { matches_by_pk } = await this.hasura.query({
      matches_by_pk: {
        __args: {
          id: matchId,
        },
        map_veto_picking_lineup_id: true,
        options: {
          type: true,
        },
        lineup_1_id: true,
        lineup_2_id: true,
        lineup_1: {
          id: true,
          name: true,
          lineup_players: {
            captain: true,
            steam_id: true,
            discord_id: true,
            placeholder_name: true,
            player: {
              name: true,
              discord_id: true,
            },
          },
        },
        lineup_2: {
          id: true,
          name: true,
          lineup_players: {
            captain: true,
            steam_id: true,
            discord_id: true,
            placeholder_name: true,
            player: {
              name: true,
              discord_id: true,
            },
          },
        },
      },
    });

    if (!matches_by_pk) {
      return;
    }

    const lineup_players = [
      ...matches_by_pk.lineup_1.lineup_players,
      ...matches_by_pk.lineup_2.lineup_players,
    ];

    const match = matches_by_pk as typeof matches_by_pk & {
      lineup_players: typeof lineup_players;
    };

    match.lineup_players = lineup_players;

    return match;
  }

  public async getMatchServer(matchId: string) {
    const { matches_by_pk } = await this.hasura.query({
      matches_by_pk: {
        __args: {
          id: matchId,
        },
        server: {
          id: true,
        },
      },
    });

    return matches_by_pk.server;
  }

  public async isDedicatedServerAvailable(
    matchId: string,
  ): Promise<string | undefined> {
    const server = await this.getMatchServer(matchId);

    if (!server) {
      throw Error("match has no server assigned");
    }

    const { servers_by_pk } = await this.hasura.query({
      servers_by_pk: {
        __args: {
          id: server.id,
        },
        id: true,
        matches_aggregate: {
          __args: {
            where: {
              id: {
                _neq: matchId,
              },
              status: {
                _in: ["Live", "Veto"],
              },
            },
          },
          aggregate: {
            count: true,
          },
        },
      },
    });

    if (!servers_by_pk) {
      throw Error("unable to find server");
    }

    return (
      servers_by_pk.matches_aggregate.aggregate?.count === 0 && servers_by_pk.id
    );
  }

  public async updateMatchStatus(matchId: string, status: e_match_status_enum) {
    await this.hasura.mutation({
      update_matches_by_pk: {
        __args: {
          pk_columns: {
            id: matchId,
          },
          _set: {
            status: status,
          },
        },
        id: true,
      },
    });
  }

  public async assignServer(matchId: string, tries = 0): Promise<void> {
    if (tries === 0) {
      await this.setServerError(matchId, null);
    }

    const { matches_by_pk: match } = await this.hasura.query({
      matches_by_pk: {
        __args: {
          id: matchId,
        },
        id: true,
        region: true,
        source: true,
        options: {
          prefer_dedicated_server: true,
        },
      },
    });

    const onDemandOnly =
      MatchAssistantService.ON_DEMAND_ONLY_SOURCES.includes(match.source);

    if (!onDemandOnly && match.options.prefer_dedicated_server) {
      try {
        const assignedDedicated = await this.assignDedicatedServer(
          match.id,
          match.region,
        );

        if (assignedDedicated) {
          await this.startMatch(matchId);
          return;
        }
      } catch (error) {
        this.logger.error(
          `[${matchId}] unable to assign dedicated server`,
          error,
        );
      }
    }

    try {
      const isAssignedOnDemand = await this.assignOnDemandServer(matchId);
      if (isAssignedOnDemand) {
        return;
      }
    } catch (error) {
      this.logger.error(
        `[${matchId}] unable to assign on demand server`,
        error,
      );
      if (error instanceof FailedToCreateOnDemandServer) {
        if (tries >= 10) {
          this.logger.error(
            `[${matchId}] max retries reached for server assignment`,
          );
          await this.updateMatchStatus(matchId, "WaitingForServer");
          return;
        }
        setTimeout(async () => {
          this.logger.log(`[${matchId}] try retry assign server....`);
          await this.assignServer(matchId, ++tries);
        }, tries * 1000);
        return;
      }
    }

    // No pod, and no second pool to fall back on. Saying so is what turns the
    // session Failed -- match_events reads WaitingForServer off a practice
    // match as "no practice server was available" -- rather than leaving it
    // Starting until the boot grace runs out.
    if (onDemandOnly) {
      this.logger.log(
        `[${matchId}] practice match, and no on demand server could be booted`,
      );
      await this.updateMatchStatus(match.id, "WaitingForServer");
      return;
    }

    // we already checked above, so we can skip trying to assign again
    if (match.options.prefer_dedicated_server) {
      this.logger.log(
        `[${matchId}] unable to assign dedicated server, trying on demand`,
      );
      await this.updateMatchStatus(match.id, "WaitingForServer");
      return;
    }

    try {
      if (await this.assignDedicatedServer(match.id, match.region)) {
        await this.startMatch(matchId);
        return;
      }
    } catch (error) {
      this.logger.error(
        `[${matchId}] unable to assign dedicated server`,
        error,
      );
    }

    this.logger.log(
      `[${matchId}] unable to assign dedicated server, updating match status to waiting for server`,
    );

    await this.updateMatchStatus(match.id, "WaitingForServer");
  }

  /**
   * The last words of a match-server pod, for surfaces that outlive it. The
   * on-demand practice boot has no other channel: nothing in that pod pings,
   * so when it wedges, this is the only place the reason exists.
   */
  public async getMatchServerLogTail(
    matchId: string,
    tailLines = 200,
  ): Promise<string | null> {
    const jobNames = await this.getMatchServerJobIds(matchId);
    const kc = new KubeConfig();
    kc.loadFromDefault();
    const core = kc.makeApiClient(CoreV1Api);

    let pods;
    try {
      pods = await core.listNamespacedPod({
        namespace: this.namespace,
        labelSelector: `job-name in (${jobNames.join(",")})`,
      });
    } catch (error) {
      this.logger.warn(
        `[${matchId}] log-tail listPods: ${(error as Error)?.message}`,
      );
      return null;
    }

    const pod = [...(pods.items ?? [])].sort((a, b) => {
      const ta = new Date(a.metadata?.creationTimestamp ?? 0).getTime();
      const tb = new Date(b.metadata?.creationTimestamp ?? 0).getTime();
      return tb - ta;
    })[0];

    if (!pod?.metadata?.name) {
      return null;
    }

    try {
      const logs = await core.readNamespacedPodLog({
        name: pod.metadata.name,
        namespace: this.namespace,
        tailLines,
      });
      const lines = String(logs ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      if (lines.length === 0) {
        return null;
      }

      this.logger.warn(
        `[${matchId}] match server log tail:\n${lines.slice(-tailLines).join("\n")}`,
      );

      // Errors first: the flagged lines are the sentence, the rest is noise.
      const flagged = lines.filter((line) =>
        /error|fail|exception|fatal|segfault|unable/i.test(line),
      );
      const picked = flagged.length > 0 ? flagged.slice(-4) : lines.slice(-4);
      return picked.join(" | ");
    } catch (error) {
      this.logger.warn(
        `[${matchId}] log-tail read: ${(error as Error)?.message}`,
      );
      return null;
    }
  }
  public async rebootOnDemandServer(matchId: string) {
    const { matches_by_pk: match } = await this.hasura.query({
      matches_by_pk: {
        __args: {
          id: matchId,
        },
        id: true,
        status: true,
        server_id: true,
        server: {
          id: true,
          game_server_node_id: true,
        },
      },
    });

    if (!match) {
      throw Error("match not found");
    }

    if (!match.server_id || !match.server?.id) {
      throw Error("match has no assigned server");
    }

    if (
      !MatchAssistantService.REBOOTABLE_ON_DEMAND_STATUSES.includes(
        match.status,
      )
    ) {
      throw Error("match server cannot be rebooted in the current match state");
    }

    if (!match.server.game_server_node_id) {
      throw Error("only on demand servers can be rebooted");
    }

    await this.setServerError(matchId, null);

    const rebooted = await this.assignOnDemandServer(matchId, {
      preserveMatchStatus: true,
    });

    if (!rebooted) {
      throw Error("no on demand servers are available to reboot this match");
    }
  }

  private async startMatch(matchId: string) {
    await this.setServerError(matchId, null);

    await this.updateMatchStatus(matchId, "Live");

    await this.sendServerMatchId(matchId);
  }

  // Temporary admin toggle (Settings -> Matchmaking -> Disable VAC) for
  // testing on VAC-secured infra without shipping a code change each time.
  // Meant to be flipped back off for real matches.
  private async getVacInsecureFlag(): Promise<string> {
    const { settings_by_pk: setting } = await this.hasura.query({
      settings_by_pk: {
        __args: {
          name: "public.disable_vac",
        },
        value: true,
      },
    });

    return setting?.value === "true" ? " -insecure" : "";
  }

  public async reserveDedicatedServer(matchId: string) {
    const serverId = await this.isDedicatedServerAvailable(matchId);
    if (!serverId) {
      this.logger.warn(
        `[${matchId}] another match is currently live, moving back to scheduled`,
      );
      await this.updateMatchStatus(matchId, "WaitingForServer");

      return;
    }

    await this.hasura.mutation({
      update_servers_by_pk: {
        __args: {
          pk_columns: {
            id: serverId,
          },
          _set: {
            reserved_by_match_id: matchId,
          },
        },
        __typename: true,
      },
    });

    await this.startMatch(matchId);
  }

  // Exclude servers still uploading demos for a recently-ended match, so a new
  // match doesn't reset the server mid-upload. Bounded so a stuck upload can't
  // take a server out of rotation forever.
  private static pendingDemoUploadExclusion() {
    const recentlyEnded = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    return {
      _not: {
        matches: {
          ended_at: { _gte: recentlyEnded },
          match_maps: {
            status: {
              _in: [
                "UploadingDemo",
                "WaitingForTV",
              ] as e_match_map_status_enum[],
            },
          },
        },
      },
    };
  }

  private async assignDedicatedServer(
    matchId: string,
    region: string,
  ): Promise<boolean> {
    return this.cache.lock(
      `assign-dedicated-server:${region}`,
      async () => {
        const { servers } = await this.hasura.query({
          servers: {
            __args: {
              limit: 1,
              order_by: [{ game_server_node: { gpu: "asc_nulls_first" } }],
              where: {
                connected: {
                  _eq: true,
                },
                enabled: {
                  _eq: true,
                },
                is_dedicated: {
                  _eq: true,
                },
                type: {
                  _eq: "Ranked",
                },
                reserved_by_match_id: {
                  _is_null: true,
                },
                ...MatchAssistantService.pendingDemoUploadExclusion(),
                ...(region
                  ? {
                      region: {
                        _eq: region,
                      },
                    }
                  : {}),
              },
            },
            id: true,
          },
        });

        const server = servers.at(0);

        if (!server) {
          return false;
        }

        this.logger.log(`[${matchId}] assigning on dedicated server`);

        await this.hasura.mutation({
          update_matches_by_pk: {
            __args: {
              pk_columns: {
                id: matchId,
              },
              _set: {
                server_id: server.id,
              },
            },
            __typename: true,
          },
        });

        await this.hasura.mutation({
          update_servers_by_pk: {
            __args: {
              pk_columns: {
                id: server.id,
              },
              _set: {
                reserved_by_match_id: matchId,
              },
            },
            __typename: true,
          },
        });

        return true;
      },
      10,
    );
  }

  private async assignOnDemandServer(
    matchId: string,
    options?: {
      preserveMatchStatus?: boolean;
    },
  ): Promise<boolean> {
    const { matches_by_pk: match } = await this.hasura.query({
      matches_by_pk: {
        __args: {
          id: matchId,
        },
        region: true,
        password: true,
        server_id: true,
        source: true,
        max_players_per_lineup: true,
        is_tournament_match: true,
        match_maps: {
          __args: {
            order_by: [
              {
                order: "asc",
              },
            ],
          },
          map: {
            name: true,
            workshop_map_id: true,
          },
          order: true,
        },
      },
    });

    if (!match) {
      throw Error("unable to find match");
    }

    const isPractice = match.source === "practice";
    // A render pod reaches its practice server over loopback, so the server
    // has to boot on a node the pod can be scheduled on. A discovery runs the
    // same quiet plugin with no pod to film it, so any node will do.
    const isRender = isPractice && (await this.isRenderPracticeMatch(matchId));
    const needsGpu =
      isRender && !(await this.isDiscoveryPracticeMatch(matchId));
    const renderNodeFilter = needsGpu
      ? {
          gpu: { _eq: true },
          gpu_rendering_enabled: { _eq: true },
          id: { _in: await this.freeRenderGpuNodeIds() },
        }
      : {};

    const { game_server_nodes } = await this.hasura.query({
      game_server_nodes: {
        __args: {
          where: {
            status: {
              _eq: "Online",
            },
            enabled: {
              _eq: true,
            },
            enabled_for_match_making: {
              _eq: true,
            },
            ...renderNodeFilter,
            ...(match.region
              ? {
                  region: {
                    _eq: match.region,
                  },
                }
              : {}),
          },
        },
        id: true,
      },
    });

    if (game_server_nodes.length === 0) {
      return false;
    }

    const practiceNodeIds = isPractice
      ? await this.practiceNodeIds(match.region)
      : null;

    if (practiceNodeIds?.length === 0) {
      this.logger.warn(
        `[${matchId}] the SwiftlyS2 plugin does not support the CS2 build on any eligible node${match.region ? ` in ${match.region}` : ""}, cannot boot a practice server`,
      );
      return false;
    }

    const map = match.match_maps.at(0).map;

    return this.cache.lock(
      `get-on-demand-server:${match.region}`,
      async () => {
        this.logger.log(`[${matchId}] assigning on demand server`);

        // Always tear down any existing k8s job for this match before creating
        // a new one. Covers three cases: (a) the match still has server_id set,
        // (b) server_id was cleared but a stale job is left over from a prior
        // assignment, (c) delete propagation is slow — the wait-until-gone loop
        // inside stopOnDemandServer(remove=true) ensures the name is free.
        await this.stopOnDemandServer(matchId, true);

        const kc = new KubeConfig();
        kc.loadFromDefault();

        const batch = kc.makeApiClient(BatchV1Api);

        const jobName = MatchAssistantService.GetMatchServerJobId(
          matchId,
          match.source,
        );

        const { servers } = await this.hasura.query({
          servers: {
            __args: {
              limit: 1,
              order_by: [
                { game_server_node: { gpu: "asc_nulls_first" } },
                {
                  updated_at: "asc",
                },
              ],
              where: {
                type: {
                  _eq: "Ranked",
                },
                enabled: {
                  _eq: true,
                },
                is_dedicated: {
                  _eq: false,
                },
                reserved_by_match_id: {
                  _is_null: true,
                },
                ...MatchAssistantService.pendingDemoUploadExclusion(),
                game_server_node: {
                  _and: [
                    {
                      enabled: {
                        _eq: true,
                      },
                      enabled_for_match_making: {
                        _eq: true,
                      },
                      status: {
                        _eq: "Online",
                      },
                    },
                    ...(match.region
                      ? [
                          {
                            region: {
                              _eq: match.region,
                            },
                          },
                        ]
                      : []),
                    ...(practiceNodeIds
                      ? [
                          {
                            id: {
                              _in: practiceNodeIds,
                            },
                          },
                        ]
                      : []),
                  ],
                },
              },
            },
            id: true,
            label: true,
            host: true,
            port: true,
            tv_port: true,
            api_password: true,
            rcon_password: true,
            game_server_node: {
              id: true,
              pin_plugin_version: true,
              pin_plugin_runtime: true,
              supports_cpu_pinning: true,
            },
            server_region: {
              is_lan: true,
              steam_relay: true,
            },
          },
        });

        const server = servers.at(-1);

        if (!server) {
          if (!options?.preserveMatchStatus) {
            await this.updateMatchStatus(matchId, "WaitingForServer");
          }
          return false;
        }

        try {
          this.logger.verbose(
            `[${matchId}] create job for on demand server (${server.label})`,
          );

          await this.hasura.mutation({
            update_servers_by_pk: {
              __args: {
                pk_columns: {
                  id: server.id,
                },
                _set: {
                  boot_status: "Creating",
                  boot_status_detail:
                    MatchAssistantService.INITIAL_BOOT_STATUS_DETAIL,
                  connected: false,
                  offline_at: null,
                  reserved_by_match_id: matchId,
                },
              },
              __typename: true,
            },
          });

          const gameServerNodeId = server.game_server_node?.id;
          const steamRelay = server.server_region?.steam_relay || false;

          let cpus: string;
          if (server.game_server_node?.supports_cpu_pinning) {
            const { settings } = await this.hasura.query({
              settings: {
                __args: {
                  where: {
                    _or: [
                      {
                        name: {
                          _eq: "enable_cpu_pinning",
                        },
                      },
                      {
                        name: {
                          _eq: "number_of_cpus_per_server",
                        },
                      },
                    ],
                  },
                },
                name: true,
                value: true,
              },
            });

            const cpuPinning = settings.find(
              (setting) => setting.name === "enable_cpu_pinning",
            );

            if (cpuPinning?.value === "true") {
              const numberOfCpus = settings.find(
                (setting) => setting.name === "number_of_cpus_per_server",
              );
              cpus = numberOfCpus?.value || "2";
            }
          }

          const sanitizedGameServerNodeId = gameServerNodeId.replaceAll(
            ".",
            "-",
          );

          const pluginImage =
            (isRender && this.gameServerConfig.utilityRenderServerImage) ||
            (isPractice
              ? await this.pluginRuntimeService.resolvePracticeServerImage(
                  server.game_server_node,
                )
              : await this.pluginRuntimeService.resolveGameServerPluginImage(
                  server.game_server_node,
                ));

          const fivestackRanksSettingName = match.is_tournament_match
            ? "fivestack_ranks_tournaments"
            : "fivestack_ranks_matches";

          const { settings_by_pk: fivestackRanksSetting } =
            await this.hasura.query({
              settings_by_pk: {
                __args: {
                  name: fivestackRanksSettingName,
                },
                name: true,
                value: true,
              },
            });

          const showEloRanks = fivestackRanksSetting?.value === "true";
          const vacInsecureFlag = await this.getVacInsecureFlag();

          const utilityPracticeEnv = isPractice
            ? await this.utilityPracticeServerEnv(isRender)
            : [];

          await batch.createNamespacedJob({
            namespace: this.namespace,
            body: {
              apiVersion: "batch/v1",
              kind: "Job",
              metadata: {
                name: jobName,
              },
              spec: {
                ttlSecondsAfterFinished: 60 * 60 * 24,
                template: {
                  metadata: {
                    name: jobName,
                    labels: {
                      job: jobName,
                    },
                  },
                  spec: {
                    restartPolicy: "Never",
                    dnsConfig: {
                      options: [
                        {
                          name: "ndots",
                          value: "1",
                        },
                      ],
                    },
                    hostNetwork: true,
                    affinity: {
                      nodeAffinity: {
                        requiredDuringSchedulingIgnoredDuringExecution: {
                          nodeSelectorTerms: [
                            {
                              matchExpressions: [
                                {
                                  key: "kubernetes.io/hostname",
                                  operator: "In",
                                  values: [gameServerNodeId],
                                },
                              ],
                            },
                          ],
                        },
                      },
                    },
                    containers: [
                      {
                        name: "game-server",
                        image: pluginImage,
                        ...(cpus
                          ? {
                              resources: {
                                requests: { cpu: cpus },
                                limits: { cpu: cpus },
                              },
                            }
                          : {}),
                        ports: [
                          { containerPort: server.port, protocol: "TCP" },
                          { containerPort: server.port, protocol: "UDP" },
                          { containerPort: server.tv_port, protocol: "TCP" },
                          { containerPort: server.tv_port, protocol: "UDP" },
                        ],
                        env: [
                          {
                            name: "GAME_NODE_SERVER",
                            value: "true",
                          },
                          {
                            name: "SERVER_PORT",
                            value: server.port.toString(),
                          },
                          { name: "TV_PORT", value: server.tv_port.toString() },
                          {
                            name: "RCON_PASSWORD",
                            value: await this.encryption.decrypt(
                              server.rcon_password,
                            ),
                          },
                          {
                            name: "EXTRA_GAME_PARAMS",
                            // Without this, CS2 (since its January 2026 update)
                            // silently drops a long list of cvars set by exec'd
                            // cfg files specifically on workshop maps ("DISALLOWED
                            // WORKSHOP CONVAR" in the server log) -- including a
                            // workshop map's own embedded config. This restores
                            // the pre-update behavior of letting a workshop map's
                            // config actually take effect.
                            value: `-disable_workshop_command_filtering -maxplayers ${match.max_players_per_lineup * 2 + 3} ${map.workshop_map_id ? `+map de_inferno` : `+map ${map.name}`} +sv_password ${match.password}${vacInsecureFlag}`,
                          },
                          { name: "SERVER_ID", value: server.id },
                          {
                            name: "SERVER_API_PASSWORD",
                            value: server.api_password,
                          },
                          {
                            name: "API_DOMAIN",
                            value: this.appConfig.apiDomain,
                          },
                          {
                            name: "RELAY_DOMAIN",
                            value: this.appConfig.relayDomain,
                          },
                          {
                            name: "DEMOS_DOMAIN",
                            value: this.appConfig.demosDomain,
                          },
                          {
                            name: "WS_DOMAIN",
                            value: this.appConfig.wsDomain,
                          },
                          {
                            name: "STEAM_RELAY",
                            value: steamRelay ? "true" : "false",
                          },
                          ...(showEloRanks
                            ? [{ name: "SHOW_ELO_RANKS", value: "true" }]
                            : []),
                          ...utilityPracticeEnv,
                        ],
                        volumeMounts: [
                          {
                            name: `steamcmd-${sanitizedGameServerNodeId}`,
                            mountPath: "/serverdata/steamcmd",
                          },
                          {
                            name: `serverfiles-${sanitizedGameServerNodeId}`,
                            mountPath: "/serverdata/serverfiles",
                          },
                          {
                            name: `demos-${sanitizedGameServerNodeId}`,
                            mountPath: "/opt/demos",
                          },
                          {
                            name: `custom-plugins-${sanitizedGameServerNodeId}`,
                            mountPath: "/opt/custom-plugins",
                          },
                        ],
                      },
                    ],
                    // TODO - should use host paths, why do we want volumes?
                    volumes: [
                      {
                        name: `steamcmd-${sanitizedGameServerNodeId}`,
                        persistentVolumeClaim: {
                          claimName: `steamcmd-${sanitizedGameServerNodeId}-claim`,
                        },
                      },
                      {
                        name: `serverfiles-${sanitizedGameServerNodeId}`,
                        persistentVolumeClaim: {
                          claimName: `serverfiles-${sanitizedGameServerNodeId}-claim`,
                        },
                      },
                      {
                        name: `demos-${sanitizedGameServerNodeId}`,
                        persistentVolumeClaim: {
                          claimName: `demos-${sanitizedGameServerNodeId}-claim`,
                        },
                      },
                      {
                        name: `custom-plugins-${sanitizedGameServerNodeId}`,
                        hostPath: {
                          path: `/opt/5stack/custom-plugins`,
                        },
                      },
                    ],
                  },
                },
                backoffLimit: 10,
              },
            },
          });

          this.logger.verbose(
            `[${matchId}] create service for on demand server`,
          );

          await this.hasura.mutation({
            update_matches_by_pk: {
              __args: {
                pk_columns: {
                  id: matchId,
                },
                _set: {
                  server_id: server.id,
                },
              },
              __typename: true,
            },
          });

          await this.delayCheckOnDemandServer(matchId);

          return true;
        } catch (error) {
          await this.stopOnDemandServer(matchId, true);

          this.logger.error(
            `[${matchId}] unable to create on demand server`,
            error?.response?.body?.message || error,
          );

          throw new FailedToCreateOnDemandServer();
        }
      },
      10,
    );
  }

  // A practice pod runs the utility practice plugin *instead of* the match plugin.
  // The image ships both and symlinks whichever INSTALL_ flag is set, so this is
  // what decides which one the server comes up with. source='practice' is the
  // marker for the utility-practice game mode: it is already what match_events
  // branches on, and it is a plain column rather than a join through the
  // game_modes feature.
  // Is this practice match backing a nade render (vs a human practising)?
  private async isRenderPracticeMatch(matchId: string): Promise<boolean> {
    const { utility_practice_sessions } = await this.hasura.query({
      utility_practice_sessions: {
        __args: {
          where: {
            match_id: { _eq: matchId },
            is_render: { _eq: true },
          },
          limit: 1,
        },
        id: true,
      },
    });
    return (utility_practice_sessions ?? []).length > 0;
  }

  // Read with SQL rather than the generated client, which predates the column.
  private async isDiscoveryPracticeMatch(matchId: string): Promise<boolean> {
    const [row] = await this.postgres.query<Array<{ discovery: boolean }>>(
      `SELECT EXISTS (
         SELECT 1
           FROM public.utility_practice_sessions
          WHERE match_id = $1::uuid
            AND is_render = true
            AND is_discovery = true
       ) AS discovery`,
      [matchId],
    );
    return row?.discovery === true;
  }

  // Same predicate as the render pod's GPU claim, so the server never lands on
  // a node whose GPU something else is already using.
  private async freeRenderGpuNodeIds(): Promise<Array<string>> {
    const rows = await this.postgres.query<Array<{ id: string }>>(
      `SELECT id
         FROM public.game_server_nodes
        WHERE id NOT IN (SELECT * FROM public.gpu_busy_node_ids())
          AND id NOT IN (SELECT * FROM public.gpu_batch_blocked_node_ids())`,
    );
    return rows.map((row) => row.id);
  }

  private async utilityPracticeServerEnv(isRender = false) {
    return [
      { name: "INSTALL_5STACK_PLUGIN", value: "false" },
      { name: "INSTALL_UTILITY_PRACTICE_PLUGIN", value: "true" },
      // The api root, not the /utility prefix: every path the plugin builds
      // already starts with it. appConfig.apiDomain is ALREADY a full
      // https:// url (configs/app.ts) -- prefixing it again produced
      // https://https://... and the pod dialled a host literally named
      // "https" until it timed out.
      {
        name: "UTILITY_URL",
        value: this.appConfig.apiDomain,
      },
      // The plugin directs the render pod's shot and draws nothing over it --
      // so no HUD addon either, whose workshop download would stall the pod.
      ...(isRender
        ? [
            { name: "UTILITY_RENDER_MODE", value: "true" },
            { name: "HUD_WORKSHOP_ID", value: "" },
          ]
        : []),
    ];
  }
  public async monitorOnDemandServerBoot(
    matchId: string,
  ): Promise<"ready" | "pending" | "stopped"> {
    const { matches_by_pk: match } = await this.hasura.query({
      matches_by_pk: {
        __args: {
          id: matchId,
        },
        id: true,
        status: true,
        source: true,
        server_id: true,
        server: {
          id: true,
          boot_status: true,
          boot_status_detail: true,
          connected: true,
          game_server_node_id: true,
          is_dedicated: true,
          reserved_by_match_id: true,
        },
      },
    });

    if (
      !match ||
      MatchAssistantService.TERMINAL_MATCH_STATUSES.includes(match.status)
    ) {
      return "stopped";
    }

    const server = match.server;
    if (
      !match.server_id ||
      !server ||
      server.is_dedicated ||
      !server.game_server_node_id ||
      server.reserved_by_match_id !== matchId
    ) {
      return "stopped";
    }

    if (server.connected) {
      await this.clearOnDemandServerBootDiagnostics(
        server.id,
        matchId,
        server.boot_status,
        server.boot_status_detail,
      );

      if (match.status === "WaitingForServer") {
        await this.startMatch(matchId);
      } else {
        await this.setServerError(matchId, null);
        await this.sendServerMatchId(matchId);
      }

      return "ready";
    }

    try {
      const diagnostics = await this.loggingService.getJobBootDiagnostics(
        MatchAssistantService.GetMatchServerJobId(matchId, match.source),
      );

      await this.syncOnDemandServerBootDiagnostics(
        server.id,
        matchId,
        server.boot_status,
        server.boot_status_detail,
        diagnostics,
      );

      return diagnostics.terminal ? "stopped" : "pending";
    } catch (error) {
      const message =
        error?.response?.body?.message ||
        error?.message ||
        "Unable to inspect match server boot status.";
      this.logger.warn(`unable to monitor on demand server`, message);
      await this.syncOnDemandServerBootDiagnostics(
        server.id,
        matchId,
        server.boot_status,
        server.boot_status_detail,
        {
          status:
            (server.boot_status as MatchServerBootDiagnostic["status"]) ||
            "Creating",
          detail: message,
          terminal: false,
        },
      );
      return "pending";
    }
  }

  private async syncOnDemandServerBootDiagnostics(
    serverId: string,
    matchId: string,
    currentStatus: string | null,
    currentDetail: string | null,
    diagnostics: MatchServerBootDiagnostic,
  ) {
    if (
      currentStatus !== diagnostics.status ||
      currentDetail !== diagnostics.detail
    ) {
      await this.hasura.mutation({
        update_servers_by_pk: {
          __args: {
            pk_columns: {
              id: serverId,
            },
            _set: {
              boot_status: diagnostics.status,
              boot_status_detail: diagnostics.detail,
            },
          },
          __typename: true,
        },
      });
    }

    await this.setServerError(
      matchId,
      diagnostics.terminal ? diagnostics.detail : null,
    );
  }

  private async clearOnDemandServerBootDiagnostics(
    serverId: string,
    matchId: string,
    currentStatus: string | null,
    currentDetail: string | null,
  ) {
    if (currentStatus !== null || currentDetail !== null) {
      await this.hasura.mutation({
        update_servers_by_pk: {
          __args: {
            pk_columns: {
              id: serverId,
            },
            _set: {
              boot_status: null,
              boot_status_detail: null,
            },
          },
          __typename: true,
        },
      });
    }

    await this.setServerError(matchId, null);
  }

  private async setServerError(matchId: string, message: string | null) {
    const { matches_by_pk } = await this.hasura.query({
      matches_by_pk: {
        __args: {
          id: matchId,
        },
        server_error: true,
      },
    });

    if ((matches_by_pk?.server_error ?? null) === (message ?? null)) {
      return;
    }

    await this.hasura.mutation({
      update_matches_by_pk: {
        __args: {
          pk_columns: {
            id: matchId,
          },
          _set: {
            server_error: message,
          },
        },
        __typename: true,
      },
    });
  }

  public async delayCheckOnDemandServer(matchId: string) {
    await this.queue.add(
      MatchJobs.CheckOnDemandServerJob,
      {
        matchId,
      },
      {
        delay: MatchAssistantService.ON_DEMAND_SERVER_BOOT_CHECK_DELAY_MS,
        attempts: 1,
        removeOnFail: true,
        removeOnComplete: true,
        jobId: `match.${matchId}.server`,
      },
    );
  }

  public async stopOnDemandServer(matchId: string, remove = false) {
    this.logger.log(`[${matchId}] stopping match servers`);

    try {
      const kc = new KubeConfig();
      kc.loadFromDefault();

      const core = kc.makeApiClient(CoreV1Api);
      const batch = kc.makeApiClient(BatchV1Api);

      // A deleted match no longer says whether it ran as u- or m-, so every
      // candidate name is stopped, not just the first.
      for (const jobName of await this.getMatchServerJobIds(matchId)) {
        if (!remove) {
          await this.signalOnDemandServerStop(matchId, jobName);
          continue;
        }

        const podList = await core.listNamespacedPod({
          namespace: this.namespace,
          labelSelector: `job-name=${jobName}`,
        });

        for (const pod of podList.items) {
          this.logger.verbose(`[${matchId}] remove pod`);

          await core
            .deleteNamespacedPod({
              name: pod.metadata!.name!,
              namespace: this.namespace,
              gracePeriodSeconds: 0,
            })
            .catch((error) => {
              if (error.code.toString() !== "404") {
                throw error;
              }
            });
        }

        this.logger.verbose(`[${matchId}] remove job`);

        await batch
          .deleteNamespacedJob({
            name: jobName,
            namespace: this.namespace,
            propagationPolicy: "Background",
            gracePeriodSeconds: 0,
          })
          .catch((error) => {
            if (error.code.toString() !== "404") {
              throw error;
            }
          });

        // Wait for the job to be fully gone from the k8s API before returning.
        // Without this, a subsequent createNamespacedJob with the same name races
        // against delete propagation and gets HTTP 409 AlreadyExists.
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
          try {
            await batch.readNamespacedJob({
              name: jobName,
              namespace: this.namespace,
            });
          } catch (error) {
            if (error.code?.toString() === "404") {
              break;
            }
            throw error;
          }
          await new Promise((r) => setTimeout(r, 200));
        }
      }

      if (!remove) {
        return;
      }

      this.logger.verbose(`[${matchId}] stopped on demand server`);
    } catch (error) {
      this.logger.error(
        `[${matchId}] unable to stop on demand server`,
        error?.response?.body?.message || error,
      );
    }

    await this.hasura.mutation({
      update_servers: {
        __args: {
          where: {
            reserved_by_match_id: {
              _eq: matchId,
            },
          },
          _set: {
            boot_status: null,
            boot_status_detail: null,
            connected: false,
            reserved_by_match_id: null,
          },
        },
        __typename: true,
      },
    });

    await this.setServerError(matchId, null);
  }

  // The queued stop can run after a restart, when the Job under this name is the new server's.
  public async stopEndedMatchServer(matchId: string) {
    if (!(await this.hasMatchEnded(matchId))) {
      this.logger.log(
        `[${matchId}] match was started again, leaving its server running`,
      );
      return;
    }

    await this.stopOnDemandServer(matchId);
  }

  public async hasMatchEnded(matchId: string): Promise<boolean> {
    const { matches_by_pk } = await this.hasura.query({
      matches_by_pk: {
        __args: {
          id: matchId,
        },
        status: true,
      },
    });

    return (
      !matches_by_pk ||
      MatchAssistantService.TERMINAL_MATCH_STATUSES.includes(
        matches_by_pk.status,
      )
    );
  }

  // A SIGUSR1 sent before setup.sh hands PID 1 to server.sh is silently ignored.
  public async removeUnstoppedOnDemandServer(
    matchId: string,
    jobUid: string,
    jobName = MatchAssistantService.GetMatchServerJobId(matchId),
  ) {
    const kc = new KubeConfig();
    kc.loadFromDefault();
    const batch = kc.makeApiClient(BatchV1Api);

    const job = await this.readOnDemandServerJob(batch, jobName);

    if (
      !job ||
      job.metadata?.uid !== jobUid ||
      MatchAssistantService.isJobFinished(job)
    ) {
      return;
    }

    const { matches, servers } = await this.getOnDemandServerJobMatches([
      matchId,
    ]);

    if (MatchAssistantService.holdsOnDemandServer(matches.at(0), servers)) {
      return;
    }

    this.logger.warn(
      `[${matchId}] on demand server did not stop after it was signalled, removing it`,
    );

    await this.removeOnDemandServerJob(matchId, jobName, { uid: jobUid });
  }

  // Upstream 5Stack's match-server reaper (5stackgg/api 085511d4), with DEAFCS
  // guards: only m-<uuid> Jobs (Pracc u- Jobs are never looked at), a match
  // that is not over keeps its server even without a reservation, a deleted
  // match waits out a grace period, the Job and match are read again right
  // before a removal, at most a few removals per sweep, and nothing is removed
  // unless MATCH_SERVER_REAPER=enforce (otherwise it only reports).
  public async reconcileOnDemandServerJobs(): Promise<void> {
    const kc = new KubeConfig();
    kc.loadFromDefault();
    const batch = kc.makeApiClient(BatchV1Api);

    let jobs: Array<V1Job>;
    try {
      ({ items: jobs } = await batch.listNamespacedJob({
        namespace: this.namespace,
        ...(this.unlabelledServerJobsRemain
          ? {}
          : { labelSelector: MatchAssistantService.MATCH_SERVER_JOB_SELECTOR }),
      }));
    } catch (error) {
      this.logger.error(
        `[match-server-reaper] listJobs failed: ${error?.message}`,
      );
      return;
    }

    const now = Date.now();
    const candidates = new Map<string, V1Job>();
    let unlabelledServerJobsRemain = false;

    for (const job of jobs) {
      const matchId = MatchAssistantService.getServerJobMatchId(job);

      if (!matchId || MatchAssistantService.isJobFinished(job)) {
        continue;
      }

      if (job.metadata?.labels?.role !== "match") {
        unlabelledServerJobsRemain = true;
      }

      const createdAt = new Date(
        job.metadata?.creationTimestamp ?? now,
      ).getTime();

      if (
        now - createdAt <
        MatchAssistantService.ORPHANED_JOB_CREATE_GRACE_MS
      ) {
        continue;
      }

      candidates.set(matchId, job);
    }

    this.unlabelledServerJobsRemain = unlabelledServerJobsRemain;

    if (candidates.size === 0) {
      return;
    }

    const { matches, servers } = await this.getOnDemandServerJobMatches([
      ...candidates.keys(),
    ]);

    const heldKeys: Array<string> = [];
    let removals = 0;

    for (const [matchId, job] of candidates) {
      const match = matches.find(({ id }) => id === matchId);
      const orphanedKey = `match-server-job:orphaned-since:${job.metadata?.uid ?? job.metadata?.name}`;

      if (MatchAssistantService.holdsOnDemandServer(match, servers)) {
        heldKeys.push(orphanedKey);
        continue;
      }

      // DEAFCS: upstream removes these after 5 minutes. A tournament reset
      // puts a finished match back to WaitingForCheckIn with its server_id and
      // no reservation, and it can go Live on that same server, so a match
      // that is not over is never treated as an orphan.
      if (
        match &&
        !MatchAssistantService.TERMINAL_MATCH_STATUSES.includes(match.status)
      ) {
        await this.reportOnDemandServerJob(
          job,
          "kept",
          `[${matchId}] keeping on demand server job ${job.metadata?.name}: match is ${match.status} but does not hold its server`,
        );
        continue;
      }

      if (match) {
        const since =
          MatchAssistantService.getMatchEndedAt(match) ||
          (await this.getOrphanedSince(orphanedKey, now));
        const grace =
          (match.options?.tv_delay ?? 0) * 1000 +
          MatchAssistantService.ORPHANED_JOB_ENDED_GRACE_MS;

        if (now - since < grace) {
          continue;
        }
      } else if (
        // DEAFCS: a deleted match waits like an unassigned one, so a single
        // read that misses the match never removes its server.
        now - (await this.getOrphanedSince(orphanedKey, now)) <
        MatchAssistantService.ORPHANED_JOB_UNASSIGNED_GRACE_MS
      ) {
        continue;
      }

      if (!this.gameServerConfig.matchServerReaperEnforce) {
        await this.reportOnDemandServerJob(
          job,
          "would-remove",
          `[${matchId}] would remove orphaned on demand server job ${job.metadata?.name} (${match ? `match is ${match.status}` : "match was deleted"}), MATCH_SERVER_REAPER is not enforce`,
        );
        continue;
      }

      if (
        removals >= MatchAssistantService.ORPHANED_JOB_MAX_REMOVALS_PER_SWEEP
      ) {
        this.logger.warn(
          `[match-server-reaper] removed ${removals} on demand server jobs, leaving the rest for the next sweep`,
        );
        break;
      }

      try {
        if (!(await this.confirmOrphanedOnDemandServerJob(matchId, job))) {
          continue;
        }

        this.logger.warn(
          `[${matchId}] removing orphaned on demand server job ${job.metadata?.name} (${match ? `match is ${match.status}` : "match was deleted"})`,
        );

        const removed = await this.removeOnDemandServerJob(
          matchId,
          job.metadata.name,
          { uid: job.metadata?.uid },
        );

        // Rows were read before the loop; the write-time condition keeps a reassignment's row.
        if (removed) {
          removals++;

          for (const server of servers) {
            if (server.reserved_by_match_id === matchId) {
              await this.releaseOnDemandServer(
                matchId,
                server.id,
                MatchAssistantService.reservationNotHeld(matchId),
              );
            }
          }
        }

        await this.cache.forget(orphanedKey);
      } catch (error) {
        this.logger.error(
          `[${matchId}] unable to remove orphaned on demand server: ${error?.message}`,
        );
      }
    }

    await this.cache.forget(...heldKeys);
  }

  // DEAFCS: the sweep read the Jobs and matches before its grace checks, so
  // both are read again right before a removal. Anything unexpected keeps the
  // server and is reported.
  private async confirmOrphanedOnDemandServerJob(
    matchId: string,
    job: V1Job,
  ): Promise<boolean> {
    const kc = new KubeConfig();
    kc.loadFromDefault();
    const batch = kc.makeApiClient(BatchV1Api);

    const current = await this.readOnDemandServerJob(batch, job.metadata.name);

    if (
      !current ||
      current.metadata?.uid !== job.metadata?.uid ||
      MatchAssistantService.isJobFinished(current)
    ) {
      return false;
    }

    const { matches, servers } = await this.getOnDemandServerJobMatches([
      matchId,
    ]);
    const match = matches.at(0);

    if (
      match &&
      !MatchAssistantService.TERMINAL_MATCH_STATUSES.includes(match.status)
    ) {
      await this.reportOnDemandServerJob(
        job,
        "kept",
        `[${matchId}] keeping on demand server job ${job.metadata?.name}: match is ${match.status} again`,
      );
      return false;
    }

    // A deleted match's reservations are cleared with it (FK and delete trigger).
    if (!match && servers.length > 0) {
      await this.reportOnDemandServerJob(
        job,
        "kept",
        `[${matchId}] keeping on demand server job ${job.metadata?.name}: match is gone but a server is still reserved by it`,
      );
      return false;
    }

    return true;
  }

  // Once per Job and reason a day, so a kept or reported Job does not log every minute.
  private async reportOnDemandServerJob(
    job: V1Job,
    reason: string,
    message: string,
  ) {
    const key = `match-server-job:reported:${reason}:${job.metadata?.uid ?? job.metadata?.name}`;

    if (await this.cache.has(key)) {
      return;
    }

    await this.cache.put(key, true, 24 * 60 * 60);

    this.logger.warn(message);
  }

  private async releaseOnDemandServer(
    matchId: string,
    serverId: string,
    condition: servers_bool_exp,
  ) {
    await this.hasura.mutation({
      update_servers: {
        __args: {
          where: {
            reserved_by_match_id: {
              _eq: matchId,
            },
            id: {
              _eq: serverId,
            },
            ...condition,
          },
          _set: {
            boot_status: null,
            boot_status_detail: null,
            connected: false,
            reserved_by_match_id: null,
          },
        },
        __typename: true,
      },
    });
  }

  private async getOnDemandServerJobMatches(matchIds: Array<string>) {
    const { matches } = await this.hasura.query({
      matches: {
        __args: {
          where: {
            id: {
              _in: matchIds,
            },
          },
        },
        id: true,
        status: true,
        ended_at: true,
        cancels_at: true,
        server_id: true,
        options: {
          tv_delay: true,
        },
      },
    });

    const { servers } = await this.hasura.query({
      servers: {
        __args: {
          where: {
            reserved_by_match_id: {
              _in: matchIds,
            },
            is_dedicated: {
              _eq: false,
            },
          },
        },
        id: true,
        reserved_by_match_id: true,
      },
    });

    return { matches, servers };
  }

  private static holdsOnDemandServer(
    match: { id: string; status: e_match_status_enum; server_id?: string },
    servers: Array<{ id: string; reserved_by_match_id?: string }>,
  ) {
    return (
      !!match?.server_id &&
      !MatchAssistantService.TERMINAL_MATCH_STATUSES.includes(match.status) &&
      servers.some(
        (server) =>
          server.id === match.server_id &&
          server.reserved_by_match_id === match.id,
      )
    );
  }

  // Canceled clears ended_at; tbu_matches stamps cancels_at at cancel time instead.
  private static getMatchEndedAt(match: {
    status: e_match_status_enum;
    ended_at?: string;
    cancels_at?: string;
  }): number | null {
    const endedAt =
      match.ended_at ?? (match.status === "Canceled" ? match.cancels_at : null);

    return endedAt ? new Date(endedAt).getTime() : null;
  }

  private async getOrphanedSince(key: string, now: number): Promise<number> {
    const since = await this.cache.get(key);

    if (typeof since === "number") {
      return since;
    }

    await this.cache.put(key, now, 24 * 60 * 60);

    return now;
  }

  private static reservedByEndedMatch(): servers_bool_exp {
    return {
      current_match: {
        status: {
          _in: [...MatchAssistantService.TERMINAL_MATCH_STATUSES],
        },
      },
    };
  }

  // holdsOnDemandServer, negated, for the update to evaluate at write time.
  private static reservationNotHeld(matchId: string): servers_bool_exp {
    return {
      _or: [
        MatchAssistantService.reservedByEndedMatch(),
        {
          _not: {
            matches: {
              id: {
                _eq: matchId,
              },
            },
          },
        },
      ],
    };
  }

  // DEAFCS: by Job name only. Upstream also trusts the role=match label, which
  // it puts on practice u- Jobs too; Pracc stays outside this sweep.
  private static getServerJobMatchId(job: V1Job): string | null {
    const matchId = MatchAssistantService.MATCH_SERVER_JOB_NAME.exec(
      job.metadata?.name ?? "",
    )?.[1];

    return matchId && MatchAssistantService.UUID.test(matchId) ? matchId : null;
  }

  private static isJobFinished(job: V1Job) {
    return (job.status?.conditions ?? []).some(
      (condition) =>
        condition.status === "True" &&
        ["Complete", "Failed", "SuccessCriteriaMet", "FailureTarget"].includes(
          condition.type,
        ),
    );
  }

  private static isGameServerRunning(pod: V1Pod) {
    if (pod.status?.phase !== "Running" || pod.metadata?.deletionTimestamp) {
      return false;
    }

    const container = pod.spec?.containers?.at(0)?.name;

    return (pod.status.containerStatuses ?? []).some(
      (status) => status.name === container && !!status.state?.running,
    );
  }

  private static isNotFound(error: { code?: number | string }) {
    return error?.code?.toString() === "404";
  }

  private static isConflict(error: { code?: number | string }) {
    return error?.code?.toString() === "409";
  }

  private static isOwnedBy(pod: V1Pod, jobUid?: string) {
    return (
      !jobUid ||
      (pod.metadata?.ownerReferences ?? []).some(
        (owner) => owner.uid === jobUid,
      )
    );
  }

  private async readOnDemandServerJob(
    batch: BatchV1Api,
    jobName: string,
  ): Promise<V1Job | null> {
    try {
      return await batch.readNamespacedJob({
        name: jobName,
        namespace: this.namespace,
      });
    } catch (error) {
      if (MatchAssistantService.isNotFound(error)) {
        return null;
      }
      throw error;
    }
  }

  private async signalOnDemandServerStop(matchId: string, jobName: string) {
    const kc = new KubeConfig();
    kc.loadFromDefault();

    const core = kc.makeApiClient(CoreV1Api);
    const batch = kc.makeApiClient(BatchV1Api);

    const job = await this.readOnDemandServerJob(batch, jobName);

    if (!job || MatchAssistantService.isJobFinished(job)) {
      return;
    }

    const { items: pods } = await core.listNamespacedPod({
      namespace: this.namespace,
      labelSelector: `job-name=${jobName}`,
    });

    const running = pods.filter((pod) =>
      MatchAssistantService.isGameServerRunning(pod),
    );

    if (running.length === 0) {
      if (pods.some((pod) => pod.status?.phase === "Succeeded")) {
        return;
      }

      // Nothing to signal: a pending pod boots anyway and a failed one is replaced (backoffLimit).
      await this.removeOnDemandServerJob(matchId, jobName, {
        uid: job.metadata?.uid,
      });
      return;
    }

    for (const pod of running) {
      this.logger.verbose(`[${matchId}] signal pod to stop`);

      try {
        await new Exec(kc).exec(
          this.namespace,
          pod.metadata!.name!,
          pod.spec!.containers?.at(0)?.name,
          ["kill", "-SIGUSR1", "1"],
          process.stdout,
          process.stderr,
          process.stdin,
          false,
        );
      } catch (error) {
        this.logger.warn(
          `[${matchId}] graceful shutdown signal failed: ${error?.message || "exec error"}`,
        );
      }
    }

    await this.scheduledMatchesQueue.add(
      MatchJobs.StopOnDemandServer,
      {
        matchId,
        jobName,
        jobUid: job.metadata?.uid,
      },
      {
        delay: MatchAssistantService.ON_DEMAND_SERVER_STOP_CHECK_DELAY_MS,
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 10 * 1000,
        },
        removeOnFail: true,
        removeOnComplete: true,
        jobId: `match.${matchId}.server-stop-check.${job.metadata?.uid}`,
      },
    );
  }

  // A uid pins the Job and its pods (409 = already replaced): a reassignment reuses the name.
  private async removeOnDemandServerJob(
    matchId: string,
    jobName: string,
    options: { uid?: string } = {},
  ): Promise<boolean> {
    const kc = new KubeConfig();
    kc.loadFromDefault();

    const core = kc.makeApiClient(CoreV1Api);
    const batch = kc.makeApiClient(BatchV1Api);

    this.logger.verbose(`[${matchId}] remove job`);

    let removed = true;

    // Job before pods, or the Job controller replaces the deleted pods.
    // The API server ignores query params once a body is sent, so options go in the body.
    await batch
      .deleteNamespacedJob({
        name: jobName,
        namespace: this.namespace,
        body: {
          propagationPolicy: "Background",
          gracePeriodSeconds: 0,
          ...(options.uid ? { preconditions: { uid: options.uid } } : {}),
        },
      })
      .catch((error) => {
        if (
          !MatchAssistantService.isNotFound(error) &&
          !(options.uid && MatchAssistantService.isConflict(error))
        ) {
          throw error;
        }
        removed = false;
      });

    const { items: pods } = await core.listNamespacedPod({
      namespace: this.namespace,
      labelSelector: `job-name=${jobName}`,
    });

    for (const pod of pods) {
      if (!MatchAssistantService.isOwnedBy(pod, options.uid)) {
        continue;
      }

      this.logger.verbose(`[${matchId}] remove pod`);

      await core
        .deleteNamespacedPod({
          name: pod.metadata!.name!,
          namespace: this.namespace,
          gracePeriodSeconds: 0,
        })
        .catch((error) => {
          if (!MatchAssistantService.isNotFound(error)) {
            throw error;
          }
        });
    }

    return removed;
  }

  // A practice server booted before practice moved to u- still runs as m-, and
  // a deleted match no longer says which it was, so both names are checked.
  private async getMatchServerJobIds(matchId: string) {
    const { matches_by_pk: match } = await this.hasura.query({
      matches_by_pk: {
        __args: {
          id: matchId,
        },
        source: true,
      },
    });

    const jobName = MatchAssistantService.GetMatchServerJobId(matchId);

    return match && match.source !== "practice"
      ? [jobName]
      : [
          MatchAssistantService.GetMatchServerJobId(matchId, "practice"),
          jobName,
        ];
  }
  public async getAvailableMaps(matchId: string) {
    const { matches_by_pk } = await this.hasura.query({
      matches_by_pk: {
        __args: {
          id: matchId,
        },
        options: {
          map_pool: {
            maps: {
              id: true,
              name: true,
            },
          },
        },
        map_veto_picks: {
          __args: {
            where: {
              _or: [
                {
                  type: {
                    _eq: "Ban",
                  },
                },
                {
                  type: {
                    _eq: "Pick",
                  },
                },
              ],
            },
          },
          map_id: true,
        },
      },
    });

    if (!matches_by_pk?.options?.map_pool) {
      throw Error("unable to find match maps");
    }

    return matches_by_pk.options.map_pool.maps.filter((map) => {
      return !matches_by_pk.map_veto_picks.find((veto) => {
        return veto.map_id === map.id;
      });
    });
  }

  private async command(matchId: string, command: Array<string> | string) {
    const server = await this.getMatchServer(matchId);
    if (!server) {
      this.logger.warn(`[${matchId}] server was not assigned to this match`);
      return;
    }
    const rcon = await this.rcon.connect(server.id);

    if (!rcon) {
      this.logger.warn(
        `[${matchId}] unable to connect to rcon for server ${server.id}`,
      );
      return;
    }

    return await rcon.send(
      Array.isArray(command) ? command.join(";") : command,
    );
  }

  public async canSchedule(matchId: string, user: User) {
    const { matches_by_pk } = await this.hasura.query(
      {
        matches_by_pk: {
          __args: {
            id: matchId,
          },
          can_schedule: true,
        },
      },
      user.steam_id,
    );

    return matches_by_pk.can_schedule;
  }

  public async canCancel(matchId: string, user: User) {
    type CancellationMatch = {
      status?: e_match_status_enum | null;
      ended_at?: string | null;
      winning_lineup_id?: string | null;
      is_tournament_match?: boolean | null;
      draft_games?: Array<{
        match_id?: string | null;
        host_steam_id?: string | number | null;
        status?: string | null;
        type?: string | null;
        elo_enabled?: boolean | null;
      }>;
    };

    // Keep the existing session-aware organizer predicate for authorization,
    // but read the cancellation facts from an admin-backed query. The user
    // role intentionally cannot select draft_games.elo_enabled.
    const organizerQuery = this.hasura.query(
      {
        matches_by_pk: {
          __args: { id: matchId },
          is_organizer: true,
        },
      },
      user.steam_id,
    );
    const matchQuery = this.hasura.query({
      matches_by_pk: {
        __args: { id: matchId },
        status: true,
        ended_at: true,
        winning_lineup_id: true,
        is_tournament_match: true,
        source: true,
        options: { type: true },
        // elo_enabled exists in the live Hasura schema, but the checked-in
        // generated types predate that column. Keep the cast local rather
        // than changing the API schema or generated schema artifacts.
        draft_games: {
          match_id: true,
          host_steam_id: true,
          status: true,
          type: true,
          elo_enabled: true,
        } as any,
      } as any,
    }) as Promise<{ matches_by_pk: CancellationMatch | null }>;

    const [{ matches_by_pk: organizerMatch }, { matches_by_pk: match }] =
      await Promise.all([organizerQuery, matchQuery]);

    if (!match || !match.status) {
      return false;
    }

    if (
      MatchAssistantService.TERMINAL_MATCH_STATUSES.includes(match.status) ||
      match.ended_at != null ||
      match.winning_lineup_id != null
    ) {
      return false;
    }

    // This preserves the existing explicit match-management permission model:
    // assigned organizers, tournament organizers, match organizers, and
    // administrators are authorized by is_match_organizer().
    if (organizerMatch?.is_organizer === true) {
      return true;
    }

    const draftGame = match.draft_games?.find(
      (draft) => String(draft.match_id) === String(matchId),
    );

    // The creator exception is deliberately narrow. A linked, completed draft
    // must explicitly opt out of ELO, must not be in a tournament bracket, and
    // must still be in a pre-live cancellable state.
    return Boolean(
      draftGame &&
      draftGame.status === "Completed" &&
      draftGame.elo_enabled === false &&
      match.is_tournament_match !== true &&
      MatchAssistantService.DRAFT_CANCELLABLE_STATUSES.includes(match.status) &&
      String(draftGame.host_steam_id) === String(user.steam_id),
    );
  }

  public async canStart(matchId: string, user: User) {
    const { matches_by_pk } = await this.hasura.query(
      {
        matches_by_pk: {
          __args: {
            id: matchId,
          },
          can_start: true,
        },
      },
      user.steam_id,
    );

    return matches_by_pk.can_start;
  }

  public async isOrganizer(matchId: string, user: User) {
    const { matches_by_pk } = await this.hasura.query(
      {
        matches_by_pk: {
          __args: {
            id: matchId,
          },
          is_organizer: true,
        },
      },
      user.steam_id,
    );

    return matches_by_pk.is_organizer;
  }

  public async canReassignWinner(matchId: string, user: User) {
    const { matches_by_pk } = await this.hasura.query(
      {
        matches_by_pk: {
          __args: { id: matchId },
          can_reassign_winner: true,
        },
      },
      user.steam_id,
    );

    return matches_by_pk?.can_reassign_winner ?? false;
  }

  public async createMatchBasedOnType(
    matchType: e_match_types_enum,
    mapPoolType: e_map_pool_types_enum,
    options: {
      mr: number;
      best_of: number;
      knife: boolean;
      map?: string;
      overtime: boolean;
      timeout_setting?: e_timeout_settings_enum;
      region?: string;
      maps?: Array<string>;
      // Pre-generated match id, so a caller retrying after a crash can find
      // the match it already created instead of inserting a second one.
      id?: string;
    },
  ) {
    let map_pool_id;

    if (!options.maps) {
      options.maps = [];
    }

    if (options.map) {
      options.maps = [options.map];
    }

    if (options.maps.length === 0) {
      const { map_pools } = await this.hasura.query({
        map_pools: {
          __args: {
            where: {
              type: {
                _eq: mapPoolType,
              },
              enabled: {
                _eq: true,
              },
            },
          },
          id: true,
        },
      });

      map_pool_id = map_pools.at(0).id;
    }

    const { insert_matches_one } = await this.hasura.mutation({
      insert_matches_one: {
        __args: {
          object: {
            ...(options.id ? { id: options.id } : {}),
            region: options.region,
            options: {
              data: {
                ...(map_pool_id
                  ? {
                      map_pool_id: map_pool_id,
                    }
                  : {}),
                ...(map_pool_id
                  ? {}
                  : {
                      map_pool: {
                        data: {
                          type: "Custom",
                          maps: {
                            data: options.maps.map((map_id) => {
                              return {
                                id: map_id,
                              };
                            }),
                          },
                        },
                      },
                    }),
                map_veto: map_pool_id !== null || options.maps.length > 1,
                mr: options.mr,
                type: matchType,
                best_of: options.best_of,
                overtime: options.overtime,
                knife_round: options.knife,
                region_veto: options.region ? false : true,
                ...(options.timeout_setting && {
                  timeout_setting: options.timeout_setting,
                }),
              },
            },
          },
        },
        id: true,
        lineup_1_id: true,
        lineup_2_id: true,
      },
    });

    return insert_matches_one;
  }

  public async createTeamVsTeamMatch(
    team1Id: string,
    team2Id: string,
    options: {
      matchOptionsId?: string | null;
      region?: string;
      organizer_steam_id: string;
      scheduled_at: string;
    },
  ) {
    if (!options.matchOptionsId) {
      throw Error("could not resolve match options for scrim");
    }

    const { teams } = await this.hasura.query({
      teams: {
        __args: {
          where: {
            id: {
              _in: [team1Id, team2Id],
            },
          },
        },
        id: true,
        name: true,
      },
    });

    const teamName = (teamId: string) => {
      return teams.find((team) => team.id === teamId)?.name;
    };

    const lineup1Id = await this.insertTeamLineup(team1Id, teamName(team1Id));
    const lineup2Id = await this.insertTeamLineup(team2Id, teamName(team2Id));

    const { insert_matches_one } = await this.hasura.mutation({
      insert_matches_one: {
        __args: {
          object: {
            region: options.region,
            organizer_steam_id: options.organizer_steam_id,
            lineup_1_id: lineup1Id,
            lineup_2_id: lineup2Id,
            match_options_id: options.matchOptionsId,
          },
        },
        id: true,
        lineup_1_id: true,
        lineup_2_id: true,
      },
    });

    await this.hasura.mutation({
      update_matches_by_pk: {
        __args: {
          pk_columns: {
            id: insert_matches_one.id,
          },
          _set: {
            scheduled_at: options.scheduled_at,
            status: "Scheduled",
          },
        },
        id: true,
      },
    });

    return insert_matches_one;
  }

  private async insertTeamLineup(
    teamId: string,
    teamName?: string,
  ): Promise<string> {
    const { insert_match_lineups_one } = await this.hasura.mutation({
      insert_match_lineups_one: {
        __args: {
          object: {
            team_id: teamId,
            team_name: teamName,
          },
        },
        id: true,
      },
    });
    return insert_match_lineups_one.id;
  }

  // Creates a match in `Scheduled` status with both lineups pre-filled. Each
  // side is either an existing team (roster auto-filled) or a manual list of
  // players. The CheckForScheduledMatches cron takes it live near kickoff.
  public async createScheduledMatch(
    organizerSteamId: string,
    input: {
      options: Record<string, unknown>;
      scheduled_at: string;
      lineup_1: { team_id?: string | null; steam_ids?: Array<string> };
      lineup_2: { team_id?: string | null; steam_ids?: Array<string> };
    },
  ) {
    const teamName = async (teamId?: string | null) => {
      if (!teamId) {
        return undefined;
      }
      const { teams_by_pk } = await this.hasura.query({
        teams_by_pk: { __args: { id: teamId }, name: true },
      });
      return teams_by_pk?.name;
    };

    const lineupData = async (side: {
      team_id?: string | null;
    }): Promise<Record<string, unknown>> =>
      side.team_id
        ? { team_id: side.team_id, team_name: await teamName(side.team_id) }
        : {};

    // When the requested kickoff is now/in the past (the "ASAP" case), skip the
    // Scheduled status so the match doesn't sit waiting for the CheckForScheduledMatches
    // cron sweep — go straight to WaitingForCheckIn like scheduleMatch does.
    const scheduledMs = input.scheduled_at
      ? new Date(input.scheduled_at).getTime()
      : 0;
    // 1 min grace absorbs client/server clock skew so "now" isn't pushed onto the cron.
    const startNow = !scheduledMs || scheduledMs <= Date.now() + 60_000;

    // Inserted via the admin client, so the tai_match auto-add-creator branch
    // (which is gated on a non-admin role) is skipped — no stray organizer.
    const { insert_matches_one } = await this.hasura.mutation({
      insert_matches_one: {
        __args: {
          object: {
            organizer_steam_id: organizerSteamId,
            scheduled_at: input.scheduled_at,
            status: startNow ? "WaitingForCheckIn" : "Scheduled",
            options: { data: input.options as any },
            lineup_1: { data: await lineupData(input.lineup_1) },
            lineup_2: { data: await lineupData(input.lineup_2) },
          },
        },
        id: true,
        lineup_1_id: true,
        lineup_2_id: true,
      },
    });

    await this.insertScheduledLineupPlayers(
      insert_matches_one.lineup_1_id,
      input.lineup_1.steam_ids,
    );
    await this.insertScheduledLineupPlayers(
      insert_matches_one.lineup_2_id,
      input.lineup_2.steam_ids,
    );

    return insert_matches_one;
  }

  private async insertScheduledLineupPlayers(
    lineupId: string | null | undefined,
    steamIds?: Array<string>,
  ) {
    if (!lineupId || !steamIds || steamIds.length === 0) {
      return;
    }

    await this.hasura.mutation({
      insert_match_lineup_players: {
        __args: {
          objects: Array.from(new Set(steamIds)).map((steam_id) => ({
            match_lineup_id: lineupId,
            steam_id,
          })),
        },
        __typename: true,
      },
    });
  }
}
