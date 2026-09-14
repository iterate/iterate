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
import worker from "./worker.ts";
import { appConfigOf, parseAppConfig, type AppConfig } from "./app-config.ts";
import { projectHostOf } from "./hosts.ts";
import type { Env } from "./control-plane.ts";

// ── app config ── THE TABLE for the app config: what the vars become, what is refused (by name),
// and the per-env memo. Each row is `{ vars, becomes | throws }`.

/** The smallest valid configuration: the name and the three required secrets. */
const MINIMAL = {
  APP_CONFIG_ENVIRONMENT_NAME: "poc",
  APP_CONFIG_PLATFORM_ORIGIN: "https://control.test",
  APP_CONFIG_PROJECT_TOKEN_SECRET: "token-secret",
  APP_CONFIG_SESSION_SECRET: "cookie-secret",
  APP_CONFIG_ADMIN_API_SECRET: "admin-secret",
};
/** What MINIMAL becomes: every optional var blank, the deploy id defaulted. */
const MINIMAL_CONFIG = {
  platformOrigin: "https://control.test",
  googleClientId: "",
  googleClientSecret: "",
  testEmailLogin: false,
  mcpOrigin: "",
  environmentName: "poc",
  projectHostnameBase: "",
  projectTokenSecret: "token-secret",
  artifactsAccountId: "",
  artifactsNamespace: "",
  sessionSecret: "cookie-secret",
  adminApiSecret: "admin-secret",
  deployId: "unversioned",
};

/** Secrets are `Redacted` (they never print); expose them for a value comparison against the plain
 *  strings above. */
const expose = (config: AppConfig) => ({
  ...config,
  projectTokenSecret: config.projectTokenSecret.exposeSecret(),
  sessionSecret: config.sessionSecret.exposeSecret(),
  adminApiSecret: config.adminApiSecret.exposeSecret(),
  googleClientSecret: config.googleClientSecret.exposeSecret(),
});

describe("parseAppConfig", () => {
  const rows: { vars: Record<string, unknown>; becomes?: unknown; throws?: RegExp }[] = [
    {
      vars: { ...MINIMAL, APP_CONFIG_TEST_EMAIL_LOGIN: "true" },
      becomes: { ...MINIMAL_CONFIG, testEmailLogin: true },
    },
    {
      vars: { ...MINIMAL, APP_CONFIG_TEST_EMAIL_LOGIN: "false" },
      becomes: MINIMAL_CONFIG,
    },
    {
      vars: { ...MINIMAL, APP_CONFIG_TEST_EMAIL_LOGIN: "yes" },
      throws: /^APP_CONFIG_TEST_EMAIL_LOGIN: expected true or false$/,
    },
    {
      vars: { ...MINIMAL, APP_CONFIG_PLATFORM_ORIGIN: "http://localhost:8788" },
      becomes: { ...MINIMAL_CONFIG, platformOrigin: "http://localhost:8788", testEmailLogin: true },
    },
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
    // a wrangler var may be a JSON object; the config parser only reads STRING vars, so a non-string
    // is ignored — the field is then unset, and its required-ness is what's refused
    {
      vars: { ...MINIMAL, APP_CONFIG_ENVIRONMENT_NAME: { not: "a string" } },
      throws: /^APP_CONFIG_ENVIRONMENT_NAME: required, but unset or blank$/,
    },
    // an APP_CONFIG_* variable this worker does not name (a typo, or the deleted login mode) is not
    // consumed: the shared parser WARNS loudly and ignores it, the rest parses
    {
      vars: { ...MINIMAL, APP_CONFIG_LOGIN_MODE: "open" },
      becomes: MINIMAL_CONFIG,
    },
  ];
  for (const { vars, becomes, throws } of rows)
    test(`${JSON.stringify(vars)} → ${throws ? `throws ${throws}` : JSON.stringify(becomes)}`, () => {
      if (throws) expect(() => parseAppConfig(vars)).toThrow(throws);
      else expect(expose(parseAppConfig(vars))).toEqual(becomes);
    });
  test("the deploy id is handed in", () => {
    expect(parseAppConfig(MINIMAL, "v-123").deployId).toBe("v-123");
  });
});

describe("public protocol origins", () => {
  const origins = {
    ...MINIMAL,
    APP_CONFIG_PLATFORM_ORIGIN: "https://os.iterate2.com",
    APP_CONFIG_MCP_ORIGIN: "https://mcp.iterate2.com",
  };
  const request = (url: string) =>
    worker.fetch(new Request(url), origins as unknown as Env, {} as ExecutionContext);

  test("MCP discovery uses its public origin and the console's issuer", async () => {
    const denied = await request("https://mcp.iterate2.com/");
    expect(denied.status).toBe(401);
    const metadataUrl = /resource_metadata="([^"]+)"/.exec(
      denied.headers.get("www-authenticate")!,
    )![1]!;
    expect(metadataUrl).toMatch(/^https:\/\/mcp\.iterate2\.com\//);
    expect(await (await request(metadataUrl)).json()).toMatchObject({
      resource: "https://mcp.iterate2.com/",
      authorization_servers: ["https://os.iterate2.com"],
    });
    expect(
      await (
        await request("https://os.iterate2.com/.well-known/oauth-authorization-server")
      ).json(),
    ).toMatchObject({
      issuer: "https://os.iterate2.com",
      authorization_endpoint: "https://os.iterate2.com/authorize",
      token_endpoint: "https://os.iterate2.com/oauth/token",
    });
  });

  test("MCP does not acquire a Cap'n Web or console route", async () => {
    expect((await request("https://mcp.iterate2.com/api")).status).toBe(404);
    expect((await request("https://mcp.iterate2.com/login")).status).toBe(404);
    expect((await request("https://unconfigured.example/api")).status).toBe(421);
  });

  test("configured origins must be distinct origins without paths", () => {
    expect(() =>
      parseAppConfig({ ...origins, APP_CONFIG_MCP_ORIGIN: "https://mcp.iterate2.com/path" }),
    ).toThrow(/origin/);
    expect(() =>
      parseAppConfig({ ...origins, APP_CONFIG_MCP_ORIGIN: origins.APP_CONFIG_PLATFORM_ORIGIN }),
    ).toThrow(/distinct/);
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
    expect(expose(appConfigOf(deployed))).toEqual({ ...MINIMAL_CONFIG, deployId: "v-9" });
    expect(expose(appConfigOf(local))).toEqual({ ...MINIMAL_CONFIG, environmentName: "test" });
    expect(expose(appConfigOf(bare))).toEqual({ ...MINIMAL_CONFIG, environmentName: "e2e" });
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
  { hostname: "os.iterate2.com", base: "iterate.app", becomes: null },
  { hostname: "iterate.app", base: "iterate.app", becomes: null },
  { hostname: "a.site.prj-1.iterate.app", base: "iterate.app", becomes: null }, // deeper than `<app>.<project>`
  { hostname: "site--prj_1.iterate.app", base: "iterate.app", becomes: null }, // `_` is not a DNS label
  { hostname: "site--prj--1.iterate.app", base: "iterate.app", becomes: null }, // a second `--`
  { hostname: "xn--acme.iterate.app", base: "iterate.app", becomes: null }, // an IDN label (punycode), not the app `xn`
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
