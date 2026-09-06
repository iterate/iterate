// app-config.test.ts — THE TABLE for app-config.ts: the engine over a row table (a required row and
// a defaulted one), this worker's own table, and the per-env memo. Each row is `{ vars, becomes |
// throws }`.
import { describe, expect, test } from "vitest";
import {
  APP_CONFIG_VAR_ROWS,
  appConfigOf,
  appConfigVarParsers,
  parseAppConfig,
  parseAppConfigVars,
  type AppConfigVarRow,
} from "./app-config.ts";

/** A row table with one required row and one defaulted row. */
const TWO_ROWS = {
  name: { name: "APP_CONFIG_NAME", parse: appConfigVarParsers.string, required: true },
  region: { name: "APP_CONFIG_REGION", parse: appConfigVarParsers.string, default: "anywhere" },
} as const satisfies Record<string, AppConfigVarRow<unknown>>;

describe("parseAppConfigVars — the engine", () => {
  const rows: { vars: Record<string, unknown>; becomes?: unknown; throws?: RegExp }[] = [
    // parses, and trims
    {
      vars: { APP_CONFIG_NAME: " poc ", APP_CONFIG_REGION: " eu " },
      becomes: { name: "poc", region: "eu" },
    },
    // defaults apply when unset AND when blank; bindings and unrelated vars are ignored
    {
      vars: { APP_CONFIG_NAME: "x", APP_CONFIG_REGION: "  ", LOADER: {}, OTHER: "ignored" },
      becomes: { name: "x", region: "anywhere" },
    },
    // refusals, each naming the variable and the shape
    { vars: {}, throws: /^APP_CONFIG_NAME: required, but unset$/ },
    { vars: { APP_CONFIG_NAME: "   " }, throws: /^APP_CONFIG_NAME: required, but blank$/ },
    // a wrangler var may be a JSON object; a row wants a string
    {
      vars: { APP_CONFIG_NAME: { not: "a string" } },
      throws: /^APP_CONFIG_NAME: expected a string variable/,
    },
    // an APP_CONFIG_* variable no row names is a typo, refused with the known names
    {
      vars: { APP_CONFIG_NAME: "x", APP_CONFIG_NAEM: "typo" },
      throws:
        /^APP_CONFIG_NAEM: unknown configuration variable \(known: APP_CONFIG_NAME, APP_CONFIG_REGION\)$/,
    },
  ];
  for (const { vars, becomes, throws } of rows)
    test(`${JSON.stringify(vars)} → ${throws ? `throws ${throws}` : JSON.stringify(becomes)}`, () => {
      if (throws) expect(() => parseAppConfigVars(TWO_ROWS, vars)).toThrow(throws);
      else expect(parseAppConfigVars(TWO_ROWS, vars)).toEqual(becomes);
    });
});

describe("parseAppConfig — this worker's table", () => {
  test("the table has exactly the rows the worker reads", () => {
    expect(Object.keys(APP_CONFIG_VAR_ROWS)).toEqual(["environmentName"]);
  });
  test("a deployment's config: the environment name from its var, the deploy id handed in", () => {
    expect(parseAppConfig({ APP_CONFIG_ENVIRONMENT_NAME: "poc" }, "v-123")).toEqual({
      environmentName: "poc",
      deployId: "v-123",
    });
  });
  test("no deploy id ⇒ unversioned; no environment name ⇒ refused by name", () => {
    expect(parseAppConfig({ APP_CONFIG_ENVIRONMENT_NAME: "solo" }).deployId).toBe("unversioned");
    expect(() => parseAppConfig({})).toThrow(/^APP_CONFIG_ENVIRONMENT_NAME: required, but unset$/);
  });
});

describe("appConfigOf — once per env object", () => {
  test("reads the version-metadata binding, blank ⇒ unversioned, and memoizes on the env", () => {
    const deployed = { APP_CONFIG_ENVIRONMENT_NAME: "poc", CF_VERSION_METADATA: { id: "v-9" } };
    const local = { APP_CONFIG_ENVIRONMENT_NAME: "test", CF_VERSION_METADATA: { id: "" } };
    const bare = { APP_CONFIG_ENVIRONMENT_NAME: "solo" };
    expect(appConfigOf(deployed)).toEqual({ environmentName: "poc", deployId: "v-9" });
    expect(appConfigOf(local)).toEqual({ environmentName: "test", deployId: "unversioned" });
    expect(appConfigOf(bare)).toEqual({ environmentName: "solo", deployId: "unversioned" });
    expect(appConfigOf(deployed)).toBe(appConfigOf(deployed)); // the same object, parsed once
    expect(appConfigOf(deployed)).not.toBe(appConfigOf(local));
  });
  test("a malformed variable throws at first use, naming it", () => {
    expect(() => appConfigOf({ APP_CONFIG_ENVIRONMENT_NAME: "" })).toThrow(
      /^APP_CONFIG_ENVIRONMENT_NAME: required, but blank$/,
    );
  });
});
