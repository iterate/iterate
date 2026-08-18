import { describe, expect, test } from "vitest";
import { DEFAULT_SEEDS, parseAppConfig } from "./config.ts";

describe("parseAppConfig", () => {
  test("absent APP_CONFIG → the solo DEFAULT_SEEDS", () => {
    const { seeds } = parseAppConfig(undefined);
    expect(seeds).toHaveLength(DEFAULT_SEEDS.length);
    expect(seeds[0]).toEqual({ pattern: ["itx", "whoami"], target: ["whoami"] });
  });

  test('explicit {"seeds": []} means DENY-ALL, never the defaults', () => {
    expect(parseAppConfig('{"seeds": []}').seeds).toEqual([]);
    expect(parseAppConfig("{}").seeds).toEqual([]); // present config, seeds defaulted empty
  });

  test("string-half seeds parse into the structured half", () => {
    const { seeds } = parseAppConfig(
      JSON.stringify({ seeds: [{ pattern: "itx.os", target: "bindings.get('FALLBACK')" }] }),
    );
    expect(seeds).toEqual([{ pattern: ["itx", "os"], target: ["bindings", ["get", "FALLBACK"]] }]);
  });

  test("malformed config fails loudly (a typo must not boot a mis-wired project)", () => {
    expect(() => parseAppConfig('{"seeds": [{"pattern": 42}]}')).toThrow();
    expect(() => parseAppConfig("not json")).toThrow();
  });
});
