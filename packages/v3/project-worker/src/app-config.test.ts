// app-config.test.ts — THE TABLE for app-config.ts: what the three vars become, what is refused (by
// name), and the per-env memo. Each row is `{ vars, becomes | throws }`.
import { describe, expect, test } from "vitest";
import { appConfigOf, parseAppConfig } from "./app-config.ts";

describe("parseAppConfig", () => {
  const rows: { vars: Record<string, unknown>; becomes?: unknown; throws?: RegExp }[] = [
    // parses, and trims; the unset vars are blank, the deploy id defaults
    {
      vars: { APP_CONFIG_ENVIRONMENT_NAME: " poc " },
      becomes: {
        environmentName: "poc",
        projectHostnameBase: "",
        projectTokenSecret: "",
        deployId: "unversioned",
      },
    },
    // every var read; bindings and unrelated vars are ignored
    {
      vars: {
        APP_CONFIG_ENVIRONMENT_NAME: "poc",
        APP_CONFIG_PROJECT_HOSTNAME_BASE: "iterate.app",
        APP_CONFIG_PROJECT_TOKEN_SECRET: "s3",
        LOADER: {},
        OTHER: "ignored",
      },
      becomes: {
        environmentName: "poc",
        projectHostnameBase: "iterate.app",
        projectTokenSecret: "s3",
        deployId: "unversioned",
      },
    },
    // refusals, each naming the variable and the shape
    { vars: {}, throws: /^APP_CONFIG_ENVIRONMENT_NAME: required, but unset or blank$/ },
    {
      vars: { APP_CONFIG_ENVIRONMENT_NAME: "   " },
      throws: /^APP_CONFIG_ENVIRONMENT_NAME: required, but unset or blank$/,
    },
    // a wrangler var may be a JSON object; a var wants a string
    {
      vars: { APP_CONFIG_ENVIRONMENT_NAME: { not: "a string" } },
      throws: /^APP_CONFIG_ENVIRONMENT_NAME: expected a string variable/,
    },
    // an APP_CONFIG_* variable this worker does not name is a typo, refused with the known names
    {
      vars: { APP_CONFIG_ENVIRONMENT_NAME: "x", APP_CONFIG_ENVIRONMENT_NAEM: "typo" },
      throws:
        /^APP_CONFIG_ENVIRONMENT_NAEM: unknown configuration variable \(known: APP_CONFIG_ENVIRONMENT_NAME, APP_CONFIG_PROJECT_HOSTNAME_BASE, APP_CONFIG_PROJECT_TOKEN_SECRET\)$/,
    },
  ];
  for (const { vars, becomes, throws } of rows)
    test(`${JSON.stringify(vars)} → ${throws ? `throws ${throws}` : JSON.stringify(becomes)}`, () => {
      if (throws) expect(() => parseAppConfig(vars)).toThrow(throws);
      else expect(parseAppConfig(vars)).toEqual(becomes);
    });
  test("the deploy id is handed in", () => {
    expect(parseAppConfig({ APP_CONFIG_ENVIRONMENT_NAME: "poc" }, "v-123").deployId).toBe("v-123");
  });
});

describe("appConfigOf — once per env object", () => {
  test("reads the version-metadata binding, blank ⇒ unversioned, and memoizes on the env", () => {
    const deployed = { APP_CONFIG_ENVIRONMENT_NAME: "poc", CF_VERSION_METADATA: { id: "v-9" } };
    const local = { APP_CONFIG_ENVIRONMENT_NAME: "test", CF_VERSION_METADATA: { id: "" } };
    const bare = { APP_CONFIG_ENVIRONMENT_NAME: "e2e" };
    const noBase = { projectHostnameBase: "", projectTokenSecret: "" };
    expect(appConfigOf(deployed)).toEqual({ environmentName: "poc", ...noBase, deployId: "v-9" });
    expect(appConfigOf(local)).toEqual({
      environmentName: "test",
      ...noBase,
      deployId: "unversioned",
    });
    expect(appConfigOf(bare)).toEqual({
      environmentName: "e2e",
      ...noBase,
      deployId: "unversioned",
    });
    expect(appConfigOf(deployed)).toBe(appConfigOf(deployed)); // the same object, parsed once
    expect(appConfigOf(deployed)).not.toBe(appConfigOf(local));
  });
  test("a malformed variable throws at first use, naming it", () => {
    expect(() => appConfigOf({ APP_CONFIG_ENVIRONMENT_NAME: "" })).toThrow(
      /^APP_CONFIG_ENVIRONMENT_NAME: required, but unset or blank$/,
    );
  });
});
