// worker.test.ts — the edge's pure halves as tables: the app config (what the vars become, what is refused,
// the per-env memo) and the project-host convention (`{ hostname, base, becomes }` rows).

import { describe, expect, test, vi } from "vitest";

// The module under test reaches classes from "cloudflare:workers" (RpcTarget, DurableObject,
// WorkerEntrypoint, the pipelining brands), which node cannot resolve — mock JUST those base classes
// (no-op shells); the module's own logic runs unmodified.
vi.mock("cloudflare:workers", () => ({
  RpcTarget: class {},
  DurableObject: class {},
  WorkerEntrypoint: class {},
  RpcPromise: class {},
  RpcProperty: class {},
}));
import { appConfigOf, parseAppConfig, projectHostOf } from "./worker.ts";

// ── app config ── THE TABLE for the app config: what the vars become, what is refused (by name),
// and the per-env memo. Each row is `{ vars, becomes | throws }`.

/** The smallest valid configuration: the name and the three required secrets. */
const MINIMAL = {
  APP_CONFIG_ENVIRONMENT_NAME: "poc",
  APP_CONFIG_PROJECT_TOKEN_SECRET: "token-secret",
  APP_CONFIG_SESSION_SECRET: "cookie-secret",
  APP_CONFIG_ADMIN_API_SECRET: "admin-secret",
};
/** What MINIMAL becomes: every optional var blank, the deploy id defaulted. */
const MINIMAL_CONFIG = {
  environmentName: "poc",
  projectHostnameBase: "",
  projectTokenSecret: "token-secret",
  artifactsAccountId: "",
  artifactsNamespace: "",
  sessionSecret: "cookie-secret",
  adminApiSecret: "admin-secret",
  deployId: "unversioned",
};

describe("parseAppConfig", () => {
  const rows: { vars: Record<string, unknown>; becomes?: unknown; throws?: RegExp }[] = [
    // parses, and trims
    {
      vars: {
        ...MINIMAL,
        APP_CONFIG_ENVIRONMENT_NAME: " poc ",
        APP_CONFIG_ADMIN_API_SECRET: " admin-secret ",
      },
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
        LOADER: {},
        OTHER: "ignored",
      },
      becomes: {
        ...MINIMAL_CONFIG,
        projectHostnameBase: "iterate.app",
        projectTokenSecret: "s3",
        artifactsAccountId: "acct",
        artifactsNamespace: "repos",
      },
    },
    // refusals, each naming the variable and the shape
    { vars: {}, throws: /^APP_CONFIG_ENVIRONMENT_NAME: required, but unset or blank$/ },
    {
      vars: { ...MINIMAL, APP_CONFIG_ENVIRONMENT_NAME: "   " },
      throws: /^APP_CONFIG_ENVIRONMENT_NAME: required, but unset or blank$/,
    },
    // the token secret signs project tokens (`mintToken`, the console's project links): a blank one
    // would sign none (a zero-length HMAC key throws) and verify none (principal.ts)
    {
      vars: { ...MINIMAL, APP_CONFIG_PROJECT_TOKEN_SECRET: undefined },
      throws: /^APP_CONFIG_PROJECT_TOKEN_SECRET: required, but unset or blank$/,
    },
    {
      vars: { ...MINIMAL, APP_CONFIG_PROJECT_TOKEN_SECRET: " " },
      throws: /^APP_CONFIG_PROJECT_TOKEN_SECRET: required, but unset or blank$/,
    },
    // the session secret signs the cookie, the same way — refused at first use, not a silent lock-out
    {
      vars: { ...MINIMAL, APP_CONFIG_SESSION_SECRET: undefined },
      throws: /^APP_CONFIG_SESSION_SECRET: required, but unset or blank$/,
    },
    {
      vars: { ...MINIMAL, APP_CONFIG_SESSION_SECRET: "  " },
      throws: /^APP_CONFIG_SESSION_SECRET: required, but unset or blank$/,
    },
    // the admin secret: a blank one would match nothing — a deployment nobody can administer
    {
      vars: { ...MINIMAL, APP_CONFIG_ADMIN_API_SECRET: undefined },
      throws: /^APP_CONFIG_ADMIN_API_SECRET: required, but unset or blank$/,
    },
    {
      vars: { ...MINIMAL, APP_CONFIG_ADMIN_API_SECRET: "" },
      throws: /^APP_CONFIG_ADMIN_API_SECRET: required, but unset or blank$/,
    },
    // a wrangler var may be a JSON object; a var wants a string
    {
      vars: { ...MINIMAL, APP_CONFIG_ENVIRONMENT_NAME: { not: "a string" } },
      throws: /^APP_CONFIG_ENVIRONMENT_NAME: expected a string variable/,
    },
    // an APP_CONFIG_* variable this worker does not name is a typo, refused with the known names —
    // the deleted login mode among them
    {
      vars: { ...MINIMAL, APP_CONFIG_LOGIN_MODE: "open" },
      throws:
        /^APP_CONFIG_LOGIN_MODE: unknown configuration variable \(known: APP_CONFIG_ENVIRONMENT_NAME, APP_CONFIG_PROJECT_HOSTNAME_BASE, APP_CONFIG_PROJECT_TOKEN_SECRET, APP_CONFIG_ARTIFACTS_ACCOUNT_ID, APP_CONFIG_ARTIFACTS_NAMESPACE, APP_CONFIG_SESSION_SECRET, APP_CONFIG_ADMIN_API_SECRET\)$/,
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

// ── project host ── the hostname convention as a table: `{ hostname, base, becomes }` rows — the
// three shapes (`<app>--<project>`, `<app>.<project>`, the apex `<project>` ⇒ no app), what is not a
// project host, and a blank base.

const rows: { hostname: string; base: string; becomes: ReturnType<typeof projectHostOf> }[] = [
  // the three shapes, one answer
  {
    hostname: "site--prj-1.iterate.app",
    base: "iterate.app",
    becomes: { app: "site", project: "prj-1" },
  },
  {
    hostname: "site.prj-1.iterate.app",
    base: "iterate.app",
    becomes: { app: "site", project: "prj-1" },
  },
  { hostname: "prj-1.iterate.app", base: "iterate.app", becomes: { app: null, project: "prj-1" } }, // the apex: no app — the config worker
  {
    hostname: "my-site--a1.iterate.app",
    base: "iterate.app",
    becomes: { app: "my-site", project: "a1" },
  },
  {
    hostname: "Site--PRJ-1.Iterate.App",
    base: "iterate.app",
    becomes: { app: "site", project: "prj-1" },
  },
  {
    hostname: "site--prj-1.localhost",
    base: "localhost",
    becomes: { app: "site", project: "prj-1" },
  },
  {
    hostname: "site--prj-1.iterate.app.", // a fully-qualified Host
    base: "iterate.app",
    becomes: { app: "site", project: "prj-1" },
  },
  // not a project host
  { hostname: "project-worker.iterate.workers.dev", base: "iterate.app", becomes: null },
  { hostname: "iterate.app", base: "iterate.app", becomes: null },
  { hostname: "a.site.prj-1.iterate.app", base: "iterate.app", becomes: null }, // deeper than `<app>.<project>`
  { hostname: "site--prj_1.iterate.app", base: "iterate.app", becomes: null }, // `_` is not a DNS label
  { hostname: "site--prj--1.iterate.app", base: "iterate.app", becomes: null }, // a second `--`
  { hostname: "site--x.prj-1.iterate.app", base: "iterate.app", becomes: null }, // an app label has single hyphens
  { hostname: "3d--prj-1.iterate.app", base: "iterate.app", becomes: null }, // an app label is an identifier
  { hostname: "3d.prj-1.iterate.app", base: "iterate.app", becomes: null },
  { hostname: "--prj-1.iterate.app", base: "iterate.app", becomes: null },
  { hostname: "site--.iterate.app", base: "iterate.app", becomes: null },
  { hostname: ".prj-1.iterate.app", base: "iterate.app", becomes: null },
  { hostname: "site--prj-1.iterate.app", base: "", becomes: null }, // blank base ⇒ no ingress
];
for (const { hostname, base, becomes } of rows)
  test(`${hostname} under ${JSON.stringify(base)} ⇒ ${JSON.stringify(becomes)}`, () => {
    expect(projectHostOf(hostname, base)).toEqual(becomes);
  });
