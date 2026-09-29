import { e_match_types_enum } from "generated";
import { MatchmakingQueueVariant } from "./MatchmakingQueueVariant";

export interface MatchmakingLobby {
  type: e_match_types_enum;
  // Absent on every lobby queued before variants existed: means Standard.
  variant?: MatchmakingQueueVariant;
  regions: string[];
  joinedAt: Date;
  lobbyId: string;
  players: Array<{
    steam_id: string;
    rank: number;
  }>;
  regionPositions: Record<string, number>;
  avgRank: number;
}
