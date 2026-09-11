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
    expect(Object.keys(APP_CONFIG_VAR_ROWS)).toEqual([
      "environmentName",
      "projectHostnameBase",
      "projects",
      "customHostnames",
    ]);
  });
  test("a deployment's config: identity plus an optional deployment-owned hostname directory", () => {
    expect(
      parseAppConfig(
        {
          APP_CONFIG_ENVIRONMENT_NAME: "poc",
          APP_CONFIG_PROJECT_HOSTNAME_BASE: "iterate2.app",
          APP_CONFIG_PROJECTS_JSON: '{"blue-team":"prj_blue"}',
          APP_CONFIG_CUSTOM_HOSTNAMES_JSON: '{"notes.example.com":"prj_notes"}',
        },
        "v-123",
      ),
    ).toEqual({
      environmentName: "poc",
      deployId: "v-123",
      projectHostnameBase: "iterate2.app",
      projects: { "blue-team": "prj_blue" },
      customHostnames: { "notes.example.com": "prj_notes" },
    });
  });
  test("old deployments keep the localhost/empty-directory defaults; malformed directories refuse", () => {
    expect(parseAppConfig({ APP_CONFIG_ENVIRONMENT_NAME: "solo" })).toMatchObject({
      deployId: "unversioned",
      projectHostnameBase: "localhost",
      projects: {},
      customHostnames: {},
    });
    expect(() =>
      parseAppConfig({
        APP_CONFIG_ENVIRONMENT_NAME: "solo",
        APP_CONFIG_PROJECTS_JSON: '{"demo":3}',
      }),
    ).toThrow(/^APP_CONFIG_PROJECTS_JSON: expected a JSON object mapping strings to strings/);
    expect(() => parseAppConfig({})).toThrow(/^APP_CONFIG_ENVIRONMENT_NAME: required, but unset$/);
  });
});

describe("appConfigOf — once per env object", () => {
  test("an explicit artifact identity works without provider metadata and invalidates on rebuild", () => {
    const vars = { APP_CONFIG_ENVIRONMENT_NAME: "celld", DEPLOYMENT_ID: " artifact-one " };
    expect(appConfigOf(vars).deployId).toBe("artifact-one");
    expect(appConfigOf({ ...vars, DEPLOYMENT_ID: "artifact-two" }).deployId).toBe("artifact-two");
    expect(appConfigOf({ ...vars, CF_VERSION_METADATA: { id: "provider-id" } }).deployId).toBe(
      "artifact-one",
    );
    expect(() => appConfigOf({ ...vars, DEPLOYMENT_ID: " " })).toThrow(/DEPLOYMENT_ID/);
  });
  test("reads the version-metadata binding, blank ⇒ unversioned, and memoizes on the env", () => {
    const deployed = { APP_CONFIG_ENVIRONMENT_NAME: "poc", CF_VERSION_METADATA: { id: "v-9" } };
    const local = { APP_CONFIG_ENVIRONMENT_NAME: "test", CF_VERSION_METADATA: { id: "" } };
    const bare = { APP_CONFIG_ENVIRONMENT_NAME: "solo" };
    expect(appConfigOf(deployed)).toMatchObject({ environmentName: "poc", deployId: "v-9" });
    expect(appConfigOf(local)).toMatchObject({ environmentName: "test", deployId: "unversioned" });
    expect(appConfigOf(bare)).toMatchObject({ environmentName: "solo", deployId: "unversioned" });
    expect(appConfigOf(deployed)).toBe(appConfigOf(deployed)); // the same object, parsed once
    expect(appConfigOf(deployed)).not.toBe(appConfigOf(local));
  });
  test("a malformed variable throws at first use, naming it", () => {
    expect(() => appConfigOf({ APP_CONFIG_ENVIRONMENT_NAME: "" })).toThrow(
      /^APP_CONFIG_ENVIRONMENT_NAME: required, but blank$/,
    );
  });
});
