import { mockDirectRequestPolicy } from "../../test/utils/direct-request-fixture";
import { ChatService } from "./chat.service";
import { ChatLobbyType } from "./enums/ChatLobbyTypes";
import { User } from "../auth/types/User";

// Draft room chat, as upstream 5Stack: anyone who may open the room reads
// it (Open access, the host, anyone with a row in it, organizers); while
// the lobby is still filling everyone in it may post; once drafting starts
// only the host, its players and organizers may post. The Chat Hub offers
// spectators the room read-only on top of exactly these rules.
describe("ChatService draft room spectators", () => {
  const roomId = "11111111-2222-4333-8444-555555555555";
  const spectator: User = {
    steam_id: "76561190000000999",
    name: "Spectator",
    role: "user",
  };
  const member: User = { ...spectator, steam_id: "76561190000000002" };
  const host: User = { ...spectator, steam_id: "76561190000000001" };
  const organizer: User = { ...spectator, role: "match_organizer" };

  let service: ChatService;
  let hasura: { query: jest.Mock };
  let draft: Record<string, unknown> | null;

  beforeEach(() => {
    draft = {
      status: "Drafting",
      match_id: null,
      host_steam_id: host.steam_id,
      players: [
        { steam_id: member.steam_id, status: "Accepted", lineup: null },
        { steam_id: "76561190000000003", status: "Waitlist", lineup: null },
      ],
    };
    hasura = {
      query: jest.fn(async (query: Record<string, unknown>) =>
        "draft_games_by_pk" in query ? { draft_games_by_pk: draft } : {},
      ),
    };
    const redis = {
      hget: jest.fn().mockResolvedValue(null),
      del: jest.fn().mockResolvedValue(1),
    };
    service = new ChatService(
      { warn: jest.fn(), log: jest.fn() } as any,
      {} as any,
      hasura as any,
      { query: jest.fn().mockResolvedValue([]) } as any,
      { getConnection: () => redis } as any,
      {} as any,
      {
        getMyBlockedSteamIds: jest.fn().mockResolvedValue(new Set()),
        isBlockedEitherDirection: jest.fn().mockResolvedValue(false),
      } as any,
      { getStatus: jest.fn().mockResolvedValue({ active: false }) } as any,
    );
    mockDirectRequestPolicy(service);
  });

  const canSend = (user: User) =>
    (service as any).canSendDraftMessage(roomId, user);

  it("lets only the host, players and organizers post once drafting starts", async () => {
    await expect(canSend(spectator)).resolves.toBe(false);
    await expect(canSend(member)).resolves.toBe(true);
    await expect(canSend(host)).resolves.toBe(true);
    await expect(canSend(organizer)).resolves.toBe(true);
    // A waitlisted backup with no seat is a spectator too.
    await expect(
      canSend({ ...spectator, steam_id: "76561190000000003" }),
    ).resolves.toBe(false);
  });

  it("keeps upstream's open lobby phase, where anyone in the room may post", async () => {
    draft!.status = "Open";
    await expect(canSend(spectator)).resolves.toBe(true);
    draft!.match_id = "match-1";
    await expect(canSend(spectator)).resolves.toBe(false);
  });

  it("rejects a spectator's direct socket send while drafting", async () => {
    jest
      .spyOn(service as any, "getUserData")
      .mockResolvedValue({ user: spectator });
    jest
      .spyOn(service as any, "getWebsiteChatMuteStatus")
      .mockResolvedValue({ active: false });
    jest.spyOn(service as any, "withinRate").mockResolvedValue(true);
    const notify = jest
      .spyOn(service as any, "to")
      .mockImplementation(() => undefined);

    await expect(
      service.sendMessageToChat(
        ChatLobbyType.Draft,
        roomId,
        spectator,
        "hello",
      ),
    ).resolves.toMatchObject({ accepted: false });
    expect(notify).not.toHaveBeenCalled();
  });

  it("refuses a spectator a video upload session while drafting", async () => {
    jest
      .spyOn(service as any, "getUserData")
      .mockResolvedValue({ user: spectator });
    jest
      .spyOn(service as any, "getWebsiteChatMuteStatus")
      .mockResolvedValue({ active: false });
    jest.spyOn(service as any, "hasLobbyPermission").mockResolvedValue(true);

    await expect(
      service.createVideoDraftSession(ChatLobbyType.Draft, roomId, spectator),
    ).resolves.toBeUndefined();
  });

  it("only admits non-members to Open rooms when joining", async () => {
    hasura.query.mockResolvedValueOnce({ draft_games: [] });
    const client = { id: "socket-1", user: spectator } as any;
    jest
      .spyOn(service as any, "refreshClientUser")
      .mockResolvedValue(spectator);
    const join = jest.spyOn(service as any, "setUserData" as any);

    await service.joinMatchLobby(client, ChatLobbyType.Draft, roomId);

    const where = JSON.stringify(hasura.query.mock.calls[0][0]);
    expect(where).toContain('"access":{"_eq":"Open"}');
    expect(where).toContain(`"host_steam_id":{"_eq":"${spectator.steam_id}"}`);
    expect(where).toContain(
      `"players":{"steam_id":{"_eq":"${spectator.steam_id}"}}`,
    );
    expect(join).not.toHaveBeenCalled();
  });
});
