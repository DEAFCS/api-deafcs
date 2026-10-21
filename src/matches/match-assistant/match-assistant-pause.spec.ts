import { MatchAssistantService } from "./match-assistant.service";

describe("MatchAssistantService.setServerPaused", () => {
  const setup = (serverRuntime: string | null, globalRuntime = "swiftlys2") => {
    const service = Object.create(
      MatchAssistantService.prototype,
    ) as MatchAssistantService;
    const sent: Array<string> = [];
    Object.assign(service, {
      postgres: {
        query: jest.fn(async () => [{ plugin_runtime: serverRuntime }]),
      },
      pluginRuntimeService: {
        getPluginRuntime: jest.fn(async () => globalRuntime),
      },
      command: jest.fn(async (_matchId: string, command: string) => {
        sent.push(command);
        return "";
      }),
    });
    return { service, sent };
  };

  it.each([
    ["swiftlys2", "swiftlys2", true, "sw_pause"],
    ["swiftlys2", "swiftlys2", false, "sw_resume"],
    ["counterstrikesharp", "swiftlys2", true, "css_pause"],
    ["counterstrikesharp", "swiftlys2", false, "css_resume"],
    [null, "counterstrikesharp", true, "css_pause"],
    [null, "swiftlys2", false, "sw_resume"],
  ])(
    "server %s (deployment %s), pause %s: sends %s",
    async (serverRuntime, globalRuntime, paused, expected) => {
      const { service, sent } = setup(serverRuntime, globalRuntime);

      await service.setServerPaused("match-1", paused);

      expect(sent).toEqual([expected]);
    },
  );
});
