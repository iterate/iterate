// app-config.test.ts — THE TABLE for app-config.ts: what the vars become, what is refused (by name),
// and the per-env memo. Each row is `{ vars, becomes | throws }`.
import { describe, expect, test } from "vitest";
import { appConfigOf, parseAppConfig } from "./app-config.ts";

/** The smallest valid configuration. */
const MINIMAL = { APP_CONFIG_ENVIRONMENT_NAME: "poc", APP_CONFIG_LOGIN_MODE: "open" };
/** What MINIMAL becomes: every optional var blank, the deploy id defaulted. */
const MINIMAL_CONFIG = {
  environmentName: "poc",
  projectHostnameBase: "",
  projectTokenSecret: "",
  artifactsAccountId: "",
  artifactsNamespace: "",
  loginMode: "open",
  sessionSecret: "",
  deployId: "unversioned",
};

describe("parseAppConfig", () => {
  const rows: { vars: Record<string, unknown>; becomes?: unknown; throws?: RegExp }[] = [
    // parses, and trims
    {
      vars: { APP_CONFIG_ENVIRONMENT_NAME: " poc ", APP_CONFIG_LOGIN_MODE: " open " },
      becomes: MINIMAL_CONFIG,
    },
    // every var read; bindings and unrelated vars are ignored
    {
      vars: {
        ...MINIMAL,
        APP_CONFIG_PROJECT_HOSTNAME_BASE: "iterate.app",
        APP_CONFIG_PROJECT_TOKEN_SECRET: "s3",
        APP_CONFIG_ARTIFACTS_ACCOUNT_ID: "acct",
        APP_CONFIG_ARTIFACTS_NAMESPACE: "repos",
        APP_CONFIG_LOGIN_MODE: "email",
        APP_CONFIG_SESSION_SECRET: "cookie-secret",
        LOADER: {},
        OTHER: "ignored",
      },
      becomes: {
        environmentName: "poc",
        projectHostnameBase: "iterate.app",
        projectTokenSecret: "s3",
        artifactsAccountId: "acct",
        artifactsNamespace: "repos",
        loginMode: "email",
        sessionSecret: "cookie-secret",
        deployId: "unversioned",
      },
    },
    // refusals, each naming the variable and the shape
    { vars: {}, throws: /^APP_CONFIG_ENVIRONMENT_NAME: required, but unset or blank$/ },
    {
      vars: { ...MINIMAL, APP_CONFIG_ENVIRONMENT_NAME: "   " },
      throws: /^APP_CONFIG_ENVIRONMENT_NAME: required, but unset or blank$/,
    },
    {
      vars: { APP_CONFIG_ENVIRONMENT_NAME: "poc" },
      throws: /^APP_CONFIG_LOGIN_MODE: expected "email" or "open", got ""$/,
    },
    {
      vars: { ...MINIMAL, APP_CONFIG_LOGIN_MODE: "magic-link" },
      throws: /^APP_CONFIG_LOGIN_MODE: expected "email" or "open", got "magic-link"$/,
    },
    // a wrangler var may be a JSON object; a var wants a string
    {
      vars: { ...MINIMAL, APP_CONFIG_ENVIRONMENT_NAME: { not: "a string" } },
      throws: /^APP_CONFIG_ENVIRONMENT_NAME: expected a string variable/,
    },
    // an APP_CONFIG_* variable this worker does not name is a typo, refused with the known names
    {
      vars: { ...MINIMAL, APP_CONFIG_ENVIRONMENT_NAEM: "typo" },
      throws:
        /^APP_CONFIG_ENVIRONMENT_NAEM: unknown configuration variable \(known: APP_CONFIG_ENVIRONMENT_NAME, APP_CONFIG_PROJECT_HOSTNAME_BASE, APP_CONFIG_PROJECT_TOKEN_SECRET, APP_CONFIG_ARTIFACTS_ACCOUNT_ID, APP_CONFIG_ARTIFACTS_NAMESPACE, APP_CONFIG_LOGIN_MODE, APP_CONFIG_SESSION_SECRET\)$/,
    },
  ];
  for (const { vars, becomes, throws } of rows)
    test(`${JSON.stringify(vars)} → ${throws ? `throws ${throws}` : JSON.stringify(becomes)}`, () => {
      if (throws) expect(() => parseAppConfig(vars)).toThrow(throws);
      else expect(parseAppConfig(vars)).toEqual(becomes);
    });
  test("the deploy id is handed in", () => {
    expect(parseAppConfig(MINIMAL, "v-123").deployId).toBe("v-123");
  });
});

describe("appConfigOf — once per env object", () => {
  test("reads the version-metadata binding, blank ⇒ unversioned, and memoizes on the env", () => {
    const deployed = { ...MINIMAL, CF_VERSION_METADATA: { id: "v-9" } };
    const local = {
      ...MINIMAL,
      APP_CONFIG_ENVIRONMENT_NAME: "test",
      CF_VERSION_METADATA: { id: "" },
    };
    const bare = { ...MINIMAL, APP_CONFIG_ENVIRONMENT_NAME: "e2e" };
    expect(appConfigOf(deployed)).toEqual({ ...MINIMAL_CONFIG, deployId: "v-9" });
    expect(appConfigOf(local)).toEqual({ ...MINIMAL_CONFIG, environmentName: "test" });
    expect(appConfigOf(bare)).toEqual({ ...MINIMAL_CONFIG, environmentName: "e2e" });
    expect(appConfigOf(deployed)).toBe(appConfigOf(deployed)); // the same object, parsed once
    expect(appConfigOf(deployed)).not.toBe(appConfigOf(local));
  });
  test("a malformed variable throws at first use, naming it", () => {
    expect(() => appConfigOf({ ...MINIMAL, APP_CONFIG_ENVIRONMENT_NAME: "" })).toThrow(
      /^APP_CONFIG_ENVIRONMENT_NAME: required, but unset or blank$/,
    );
  });
});
