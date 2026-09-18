import { ChatService } from "./chat.service";
import { ChatLobbyType } from "./enums/ChatLobbyTypes";
import { User } from "../auth/types/User";

describe("ChatService tournament access", () => {
  const tournamentId = "00000000-0000-0000-0000-000000000123";
  const player: User = {
    steam_id: "76561190000000123",
    name: "Player",
    role: "verified_user",
  };

  let service: ChatService;
  let hasura: { query: jest.Mock };
  let redis: Record<string, jest.Mock>;
  let postgres: { query: jest.Mock };

  beforeEach(() => {
    hasura = { query: jest.fn() };
    redis = {
      hget: jest.fn().mockResolvedValue(null),
      hgetall: jest.fn().mockResolvedValue({}),
      hset: jest.fn().mockResolvedValue(1),
      hdel: jest.fn().mockResolvedValue(1),
      expire: jest.fn().mockResolvedValue(1),
      eval: jest.fn().mockResolvedValue([1, 1]),
      get: jest.fn().mockResolvedValue(null),
      sendCommand: jest.fn().mockResolvedValue(1),
      publish: jest.fn().mockResolvedValue(1),
      del: jest.fn().mockResolvedValue(1),
    };
    postgres = { query: jest.fn().mockResolvedValue([]) };

    service = new ChatService(
      { warn: jest.fn() } as any,
      {} as any,
      hasura as any,
      postgres as any,
      { getConnection: () => redis } as any,
      {} as any,
    );
  });

  it("uses canonical individual signup states in tournament authorization", async () => {
    hasura.query.mockResolvedValue({ tournaments: [{ id: tournamentId }] });

    await expect(
      (service as any).canAccessTournamentChat(tournamentId, player.steam_id),
    ).resolves.toBe(true);

    const [query, steamId] = hasura.query.mock.calls[0];
    expect(steamId).toBe(player.steam_id);
    expect(query.tournaments.__args.where._or[2].individual_signups).toEqual({
      player_steam_id: { _eq: player.steam_id },
      status: { _in: ["Registered", "Waitlisted", "Assigned"] },
    });
  });

  it("lets an authorized participant join and receive roster plus message history", async () => {
    jest.spyOn(service as any, "refreshClientUser").mockResolvedValue(player);
    jest
      .spyOn(service as any, "canAccessTournamentChat")
      .mockResolvedValue(true);
    jest.spyOn(service, "to").mockResolvedValue(undefined);
    const client = {
      id: "socket-1",
      user: { ...player },
      send: jest.fn(),
      on: jest.fn(),
    };

    await service.joinMatchLobby(
      client as any,
      ChatLobbyType.Tournament,
      tournamentId,
    );

    expect(redis.hset).toHaveBeenCalledWith(
      `chat:tournament:${tournamentId}`,
      player.steam_id,
      expect.any(String),
    );
    expect(client.send).toHaveBeenCalledTimes(3);
    expect(client.send.mock.calls.map(([message]) => message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`lobby:tournament:${tournamentId}:list`),
        expect.stringContaining(`lobby:tournament:${tournamentId}:messages`),
      ]),
    );
  });

  it("denies an unrelated user from joining or loading tournament chat", async () => {
    jest.spyOn(service as any, "refreshClientUser").mockResolvedValue(player);
    jest
      .spyOn(service as any, "canAccessTournamentChat")
      .mockResolvedValue(false);
    const client = {
      id: "socket-1",
      user: { ...player },
      send: jest.fn(),
      on: jest.fn(),
    };

    await service.joinMatchLobby(
      client as any,
      ChatLobbyType.Tournament,
      tournamentId,
    );

    expect(redis.hset).not.toHaveBeenCalled();
    expect(client.send).not.toHaveBeenCalled();
  });

  it("rechecks canonical membership before sending and evicts a withdrawn sender", async () => {
    redis.hget.mockResolvedValue(JSON.stringify({ user: player }));
    jest
      .spyOn(service as any, "canAccessTournamentChat")
      .mockResolvedValue(false);

    await service.sendMessageToChat(
      ChatLobbyType.Tournament,
      tournamentId,
      player,
      "should not send",
    );

    expect(redis.hdel).toHaveBeenCalledWith(
      `chat:tournament:${tournamentId}`,
      player.steam_id,
    );
    expect(redis.del).toHaveBeenCalledWith(
      `chat:tournament:${tournamentId}:sessions:${player.steam_id}`,
    );
    expect(redis.sendCommand).not.toHaveBeenCalled();
  });

  it("allows a current participant to send tournament chat", async () => {
    redis.hget.mockResolvedValue(JSON.stringify({ user: player }));
    jest
      .spyOn(service as any, "canAccessTournamentChat")
      .mockResolvedValue(true);
    jest.spyOn(service, "to").mockResolvedValue(undefined);
    jest
      .spyOn(service as any, "notifyLobbyMembers")
      .mockResolvedValue(undefined);

    await service.sendMessageToChat(
      ChatLobbyType.Tournament,
      tournamentId,
      player,
      "hello",
    );

    expect(redis.sendCommand).toHaveBeenCalledTimes(1);
    expect(service.to).toHaveBeenCalledWith(
      ChatLobbyType.Tournament,
      tournamentId,
      "chat",
      expect.objectContaining({ message: "hello" }),
    );
  });

  it("rejects a website-muted sender before persistence or broadcast", async () => {
    postgres.query.mockResolvedValueOnce([
      { remove_sanction_date: new Date(Date.now() + 60_000).toISOString() },
    ]);
    jest.spyOn(service, "to").mockResolvedValue(undefined);

    await expect(
      service.sendMessageToChat(
        ChatLobbyType.Global,
        "global",
        player,
        "blocked",
      ),
    ).resolves.toEqual({
      accepted: false,
      muteStatus: expect.objectContaining({ active: true, permanent: false }),
    });

    expect(redis.hset).not.toHaveBeenCalled();
    expect(redis.sendCommand).not.toHaveBeenCalled();
    expect(service.to).not.toHaveBeenCalled();
  });

  it("does not apply website chat mutes to CS2-originated chat", async () => {
    jest.spyOn(service, "to").mockResolvedValue(undefined);
    jest
      .spyOn(service as any, "notifyLobbyMembers")
      .mockResolvedValue(undefined);

    await expect(
      service.sendMessageToChat(
        ChatLobbyType.Match,
        "match-1",
        player,
        "from CS2",
        true,
      ),
    ).resolves.toEqual({ accepted: true });

    expect(postgres.query).not.toHaveBeenCalled();
    expect(redis.hset).toHaveBeenCalledTimes(1);
    expect(service.to).toHaveBeenCalledTimes(1);
  });

  it("filters withdrawn listeners while leaving Global Chat delivery unchanged", async () => {
    jest
      .spyOn(service as any, "getAllUsersInLobby")
      .mockResolvedValue([{ steamId: "registered" }, { steamId: "withdrawn" }]);
    jest
      .spyOn(service as any, "canAccessTournamentChat")
      .mockImplementation(
        async (_id: string, steamId: string) => steamId === "registered",
      );

    await service.to(ChatLobbyType.Tournament, tournamentId, "chat", {
      message: "hello",
    });

    expect(redis.publish).toHaveBeenCalledTimes(1);
    expect(redis.publish.mock.calls[0][1]).toContain('"steamId":"registered"');
    expect(redis.hdel).toHaveBeenCalledWith(
      `chat:tournament:${tournamentId}`,
      "withdrawn",
    );

    redis.publish.mockClear();
    redis.hdel.mockClear();
    await service.to(ChatLobbyType.Global, "global", "chat", {
      message: "global",
    });

    expect(redis.publish).toHaveBeenCalledTimes(2);
    expect(redis.hdel).not.toHaveBeenCalled();
  });

  it("includes individual signups in tournament push recipients", async () => {
    hasura.query.mockResolvedValue({
      tournament_team_roster: [{ player_steam_id: "roster" }],
      tournament_individual_signups: [{ player_steam_id: "signup" }],
      tournament_teams: [{ owner_steam_id: "owner" }],
      tournaments_by_pk: {
        organizer_steam_id: "organizer",
        organizers: [{ steam_id: "co-organizer" }],
      },
    });

    await expect(
      (service as any).getLobbyMemberSteamIds(
        ChatLobbyType.Tournament,
        tournamentId,
      ),
    ).resolves.toEqual([
      "roster",
      "signup",
      "owner",
      "organizer",
      "co-organizer",
    ]);

    const query = hasura.query.mock.calls[0][0];
    expect(query.tournament_individual_signups.__args.where.status).toEqual({
      _in: ["Registered", "Waitlisted", "Assigned"],
    });
  });
});
