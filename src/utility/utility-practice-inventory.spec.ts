import { UtilityPracticeService } from "./utility-practice.service";

// DEAFCS: a practice server runs no match plugin, so it never execs the
// Competitive cfg where the DEAFCS inventory service is set. Its InventorySimulator
// lines are handed over with the session instead. Placeholder values only.
describe("UtilityPracticeService inventory settings", () => {
  const cfg = [
    "// DEAFCS competitive",
    "mp_maxrounds 24",
    'mp_teamname_1 "Team A"',
    'invsim_url "https://inventory.example.test"',
    "invsim_apikey test-key",
    "invsim_ws_enabled 1",
    "  INVSIM_REQUIRE_INVENTORY 1 // trailing comment",
    "sv_cheats 0",
  ].join("\r\n");

  it("keeps only the InventorySimulator lines, values unquoted", () => {
    expect(UtilityPracticeService.inventorySettings(cfg)).toEqual([
      { name: "invsim_url", value: "https://inventory.example.test" },
      { name: "invsim_apikey", value: "test-key" },
      { name: "invsim_ws_enabled", value: "1" },
      { name: "invsim_require_inventory", value: "1" },
    ]);
  });

  it("drops a value that could carry a second command", () => {
    expect(
      UtilityPracticeService.inventorySettings(
        [
          "invsim_ws_enabled 1;quit",
          'invsim_url "https://x.test";quit',
          'invsim_chat_prefix "a;b"',
        ].join("\n"),
      ),
    ).toEqual([{ name: "invsim_url", value: "https://x.test" }]);
  });

  it("ignores names that are not InventorySimulator's", () => {
    expect(
      UtilityPracticeService.inventorySettings(
        ["invsimurl x", "xinvsim_url y", "sv_password z", "rcon_password w"].join(
          "\n",
        ),
      ),
    ).toEqual([]);
  });

  it("has nothing to give when there is no Competitive cfg", () => {
    expect(UtilityPracticeService.inventorySettings(null)).toEqual([]);
    expect(UtilityPracticeService.inventorySettings("")).toEqual([]);
  });

  it("reads the Competitive match type cfg", async () => {
    const postgres = {
      query: jest.fn(async () => [{ cfg: "invsim_ws_enabled 1" }]),
    };
    const service = Object.create(
      UtilityPracticeService.prototype,
    ) as UtilityPracticeService;
    (service as any).postgres = postgres;

    await expect(service.inventorySettings()).resolves.toEqual([
      { name: "invsim_ws_enabled", value: "1" },
    ]);
    expect(postgres.query).toHaveBeenCalledWith(
      expect.stringContaining("FROM public.match_type_cfgs"),
      ["Competitive"],
    );
  });
});
