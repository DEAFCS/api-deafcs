import {
  buildForcedClientNamesFile,
  isSafeForcedClientName,
} from "./forcedClientNames";

describe("buildForcedClientNamesFile", () => {
  it("writes the KeyValues Names block", () => {
    expect(
      buildForcedClientNamesFile([
        { steam_id: "76561198414679935", name: "prowolfsmurf" },
        { steam_id: "76561198872261023", name: "K7mA-2zQ9:Xc4P" },
      ]),
    ).toBe(
      '"Names"\n{\n\t"76561198414679935"\t"prowolfsmurf"\n\t"76561198872261023"\t"K7mA-2zQ9:Xc4P"\n}\n',
    );
  });

  it("keeps spaces and dots", () => {
    expect(
      buildForcedClientNamesFile([
        { steam_id: "76561190000000001", name: "wtf.kalle deaf" },
      ]),
    ).toContain('"wtf.kalle deaf"');
  });

  it("skips empty names and names with quotes, backslashes or newlines", () => {
    const out = buildForcedClientNamesFile([
      { steam_id: "76561190000000001", name: "" },
      { steam_id: "76561190000000002", name: '  ' },
      { steam_id: "76561190000000003", name: null },
      { steam_id: "76561190000000004", name: 'a"b' },
      { steam_id: "76561190000000005", name: "a\\b" },
      { steam_id: "76561190000000006", name: "a\nb" },
      { steam_id: "76561190000000007", name: "Good" },
    ]);
    expect(out).toBe('"Names"\n{\n\t"76561190000000007"\t"Good"\n}\n');
  });

  it("skips malformed steam ids and still yields a valid empty block", () => {
    expect(
      buildForcedClientNamesFile([{ steam_id: "123", name: "Short" }]),
    ).toBe('"Names"\n{\n}\n');
  });

  it("isSafeForcedClientName", () => {
    expect(isSafeForcedClientName("Neo")).toBe(true);
    expect(isSafeForcedClientName('x"')).toBe(false);
  });
});
