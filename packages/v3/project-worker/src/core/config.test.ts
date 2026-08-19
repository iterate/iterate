import { describe, expect, test } from "vitest";
import { DEFAULT_CONFIG_MOUNTS, parseAppConfig } from "./config.ts";

describe("parseAppConfig", () => {
  test("absent APP_CONFIG → the solo DEFAULT_CONFIG_MOUNTS", () => {
    const { configMounts } = parseAppConfig(undefined);
    expect(configMounts).toHaveLength(DEFAULT_CONFIG_MOUNTS.length);
    expect(configMounts[0]).toEqual({ path: ["itx", "whoami"], target: ["whoami"] });
  });

  test('explicit {"configMounts": []} means DENY-ALL, never the defaults', () => {
    expect(parseAppConfig('{"configMounts": []}').configMounts).toEqual([]);
    expect(parseAppConfig("{}").configMounts).toEqual([]); // present config, mounts defaulted empty
  });

  test("string-half config mounts parse into the structured half", () => {
    const { configMounts } = parseAppConfig(
      JSON.stringify({ configMounts: [{ path: "itx.os", target: "bindings.get('FALLBACK')" }] }),
    );
    expect(configMounts).toEqual([
      { path: ["itx", "os"], target: ["bindings", ["get", "FALLBACK"]] },
    ]);
  });

  test("a capability path with a call is rejected (paths are dotted names only)", () => {
    expect(() =>
      parseAppConfig(JSON.stringify({ configMounts: [{ path: "itx.f('x')", target: "kv" }] })),
    ).toThrow();
  });

  test("malformed config fails loudly (a typo must not boot a mis-wired project)", () => {
    expect(() => parseAppConfig('{"configMounts": [{"path": 42}]}')).toThrow();
    expect(() => parseAppConfig("not json")).toThrow();
  });
});
