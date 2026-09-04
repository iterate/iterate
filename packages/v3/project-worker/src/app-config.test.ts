// app-config.test.ts — THE TABLE for app-config.ts: the engine over rows of every parser kind, this
// worker's own table, and the per-env memo. Each row is `{ vars, becomes | throws }`.
import { describe, expect, test } from "vitest";
import {
  APP_CONFIG_VAR_ROWS,
  appConfigOf,
  appConfigVarParsers,
  parseAppConfig,
  parseAppConfigVars,
  type AppConfigVarRow,
} from "./app-config.ts";

/** A row table exercising every parser kind, with one required row and one default per kind. */
const EVERY_KIND = {
  name: { name: "APP_CONFIG_NAME", parse: appConfigVarParsers.string, required: true },
  limit: { name: "APP_CONFIG_LIMIT", parse: appConfigVarParsers.integer, default: 10 },
  strict: { name: "APP_CONFIG_STRICT", parse: appConfigVarParsers.boolean, default: false },
  origin: {
    name: "APP_CONFIG_ORIGIN",
    parse: appConfigVarParsers.url,
    default: "https://example.test/",
  },
  extras: { name: "APP_CONFIG_EXTRAS", parse: appConfigVarParsers.json, default: null as unknown },
} as const satisfies Record<string, AppConfigVarRow<unknown>>;

describe("parseAppConfigVars — the engine", () => {
  const rows: { vars: Record<string, unknown>; becomes?: unknown; throws?: RegExp }[] = [
    // every kind parses, and trims
    {
      vars: {
        APP_CONFIG_NAME: " poc ",
        APP_CONFIG_LIMIT: " 42 ",
        APP_CONFIG_STRICT: "true",
        APP_CONFIG_ORIGIN: "https://os.iterate.com",
        APP_CONFIG_EXTRAS: '{"a":[1]}',
      },
      becomes: {
        name: "poc",
        limit: 42,
        strict: true,
        origin: "https://os.iterate.com/",
        extras: { a: [1] },
      },
    },
    // defaults apply when unset AND when blank; bindings and unrelated vars are ignored
    {
      vars: { APP_CONFIG_NAME: "x", APP_CONFIG_LIMIT: "  ", LOADER: {}, OTHER: "ignored" },
      becomes: {
        name: "x",
        limit: 10,
        strict: false,
        origin: "https://example.test/",
        extras: null,
      },
    },
    // refusals, each naming the variable and the shape
    { vars: {}, throws: /^APP_CONFIG_NAME: required, but unset$/ },
    { vars: { APP_CONFIG_NAME: "   " }, throws: /^APP_CONFIG_NAME: required, but blank$/ },
    {
      vars: { APP_CONFIG_NAME: "x", APP_CONFIG_LIMIT: "abc" },
      throws: /^APP_CONFIG_LIMIT: expected an integer, got "abc"$/,
    },
    {
      vars: { APP_CONFIG_NAME: "x", APP_CONFIG_LIMIT: "4.5" },
      throws: /^APP_CONFIG_LIMIT: expected an integer/,
    },
    {
      vars: { APP_CONFIG_NAME: "x", APP_CONFIG_STRICT: "yes" },
      throws: /^APP_CONFIG_STRICT: expected "true" or "false", got "yes"$/,
    },
    {
      vars: { APP_CONFIG_NAME: "x", APP_CONFIG_ORIGIN: "not a url" },
      throws: /^APP_CONFIG_ORIGIN: expected an absolute URL, got "not a url"$/,
    },
    {
      vars: { APP_CONFIG_NAME: "x", APP_CONFIG_EXTRAS: "{oops" },
      throws: /^APP_CONFIG_EXTRAS: expected JSON, got "\{oops"$/,
    },
    // a wrangler var may be a JSON object; a row wants a string
    {
      vars: { APP_CONFIG_NAME: { not: "a string" } },
      throws: /^APP_CONFIG_NAME: expected a string variable/,
    },
    // an APP_CONFIG_* variable no row names is a typo, refused with the known names
    {
      vars: { APP_CONFIG_NAME: "x", APP_CONFIG_NAEM: "typo" },
      throws:
        /^APP_CONFIG_NAEM: unknown configuration variable \(known: APP_CONFIG_EXTRAS, APP_CONFIG_LIMIT, APP_CONFIG_NAME, APP_CONFIG_ORIGIN, APP_CONFIG_STRICT\)$/,
    },
  ];
  for (const { vars, becomes, throws } of rows)
    test(`${JSON.stringify(vars)} → ${throws ? `throws ${throws}` : JSON.stringify(becomes)}`, () => {
      if (throws) expect(() => parseAppConfigVars(EVERY_KIND, vars)).toThrow(throws);
      else expect(parseAppConfigVars(EVERY_KIND, vars)).toEqual(becomes);
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
