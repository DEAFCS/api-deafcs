import { DraftGameService } from "./draft-game.service";
import { User } from "../auth/types/User";

describe("DraftGameService block enforcement", () => {
  const host: User = {
    steam_id: "76561190000000001",
    name: "Host",
    role: "verified_user",
  };
  const targetSteamId = "76561190000000002";
  const draftGameId = "draft-1";

  let service: DraftGameService;
  let hasura: { mutation: jest.Mock; query: jest.Mock };
  let cache: { lock: jest.Mock };
  let postgres: { query: jest.Mock };
  let blocks: { isBlockedEitherDirection: jest.Mock };

  beforeEach(() => {
    hasura = { mutation: jest.fn(), query: jest.fn() };
    // draftLock/playerLock both go through cache.lock -- just run the
    // callback directly, no real locking needed for this test.
    cache = { lock: jest.fn((_key: string, cb: () => Promise<unknown>) => cb()) };
    postgres = { query: jest.fn() };
    blocks = { isBlockedEitherDirection: jest.fn() };

    service = new DraftGameService(
      { warn: jest.fn(), log: jest.fn() } as any,
      hasura as any,
      cache as any,
      {} as any, // DraftService (forwardRef)
      { add: jest.fn() } as any, // queue
      postgres as any,
      blocks as any,
    );

    jest.spyOn(service, "getDraftGame").mockResolvedValue({
      id: draftGameId,
      host_steam_id: host.steam_id,
      status: "Open",
      match_id: null,
      players: [],
      min_elo: null,
      max_elo: null,
      type: "5v5",
    } as any);
  });

  it("refuses to add a player who has a block relationship with the host, before touching eligibility/insert", async () => {
    blocks.isBlockedEitherDirection.mockResolvedValue(true);

    await expect(
      service.addDraftPlayer(host, draftGameId, targetSteamId),
    ).rejects.toThrow("You cannot add a blocked player");

    expect(blocks.isBlockedEitherDirection).toHaveBeenCalledWith(
      host.steam_id,
      targetSteamId,
    );
    expect(hasura.mutation).not.toHaveBeenCalled();
    expect(postgres.query).not.toHaveBeenCalled();
  });

  it("checks the block relationship for both invite paths (direct-add and invite-required)", async () => {
    blocks.isBlockedEitherDirection.mockResolvedValue(true);

    await expect(
      service.addDraftPlayer(host, draftGameId, targetSteamId),
    ).rejects.toThrow("You cannot add a blocked player");

    // The check happens before canAddWithoutInvite branches at all --
    // same rejection regardless of which status the player would have
    // otherwise landed in (Invited vs Accepted/Waitlist).
    expect(blocks.isBlockedEitherDirection).toHaveBeenCalledTimes(1);
  });
});
