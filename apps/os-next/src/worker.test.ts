// worker.test.ts — the edge's pure halves as tables: the app config (what the one object becomes,
// what is refused by name, the per-env memo, the derived keys), the platform's own doors (the public
// protocol origins, `/version`, and under path routing the platform's own paths never a project),
// and the custom-hostname map. The ingress convention itself (subdomains, paths) is the SDK's
// project-ingress module and its own table.

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
import { customProjectHostOf } from "iterate/next/project-ingress";
import worker from "./worker.ts";
import {
  appConfigOf,
  atRestKeysOf,
  parseAppConfig,
  sessionSigningSecretOf,
  type AppConfig,
} from "./app-config.ts";
import type { Env } from "./env.ts";

// ── app config ── THE TABLE for the app config: what the vars become, what is refused (by name),
// and the per-env memo. Each row is `{ vars, becomes | throws, warns? }`.

/** The smallest valid configuration: the key and one sign-in mechanism, as two override vars. */
const MINIMAL = {
  APP_CONFIG_SECRETS__KEY: "secrets-key",
  APP_CONFIG_LOGIN__PASSWORD: "password",
};
/** The same, as the one object. */
const MINIMAL_BLOB = {
  APP_CONFIG: JSON.stringify({ login: { password: "password" }, secrets: { key: "secrets-key" } }),
};
/** What MINIMAL becomes: every optional field blank, the ingress unset, the deploy id defaulted. */
const MINIMAL_CONFIG = {
  urls: { os: "", mcp: "", dash: "", ingressRouting: null, temporaryCustomHostnames: {} },
  login: { password: "password" },
  secrets: { key: "secrets-key", previousKey: "", adminBearer: "" },
  deployId: "unversioned",
};

/** Secrets are `Redacted` (they never print); expose them for a value comparison against the plain
 *  strings above. */
const expose = (config: AppConfig) => ({
  urls: config.urls,
  login: {
    ...config.login,
    password: config.login.password.exposeSecret(),
    ...(config.login.google && {
      google: {
        clientId: config.login.google.clientId,
        clientSecret: config.login.google.clientSecret.exposeSecret(),
      },
    }),
    ...(config.login.cloudflare && {
      cloudflare: {
        clientId: config.login.cloudflare.clientId,
        clientSecret: config.login.cloudflare.clientSecret.exposeSecret(),
      },
    }),
  },
  secrets: {
    key: config.secrets.key.exposeSecret(),
    previousKey: config.secrets.previousKey.exposeSecret(),
    adminBearer: config.secrets.adminBearer.exposeSecret(),
  },
  deployId: config.deployId,
});

describe("parseAppConfig", () => {
  const rows: {
    vars: Record<string, unknown>;
    becomes?: unknown;
    throws?: RegExp;
    /** how many unknown keys the boot warns about (the shared parser's for a stray var, ours for a
     *  key inside the object) */
    warns?: number;
  }[] = [
    // the object alone, the overrides alone, and both — an override wins over the object
    { vars: MINIMAL_BLOB, becomes: MINIMAL_CONFIG },
    { vars: MINIMAL, becomes: MINIMAL_CONFIG },
    {
      vars: {
        APP_CONFIG: JSON.stringify({
          urls: { os: "https://from-the-object.test" },
          login: { password: "password" },
          secrets: { key: "secrets-key" },
        }),
        APP_CONFIG_URLS__OS: "https://from-the-override.test",
      },
      becomes: {
        ...MINIMAL_CONFIG,
        urls: { ...MINIMAL_CONFIG.urls, os: "https://from-the-override.test" },
      },
    },
    // a blank var is unset (a deployment's generated vars may spell a blank), and values are trimmed
    {
      vars: {
        ...MINIMAL,
        APP_CONFIG_SECRETS__KEY: " secrets-key ",
        APP_CONFIG_URLS__OS: "   ",
        APP_CONFIG_URLS__MCP: "",
        APP_CONFIG_URLS__INGRESS_ROUTING: "",
      },
      becomes: MINIMAL_CONFIG,
    },
    // every field read (the ingress hostname lowercased, the custom hostnames a real object);
    // bindings and unrelated vars are ignored
    {
      vars: {
        ...MINIMAL,
        APP_CONFIG_URLS__OS: "https://os.iterate2.com",
        APP_CONFIG_URLS__MCP: "https://mcp.iterate2.com",
        APP_CONFIG_URLS__DASH: "https://dash.iterate2.com",
        APP_CONFIG_URLS__INGRESS_ROUTING: '{"type":"subdomains","hostname":"Iterate2.app"}',
        APP_CONFIG_URLS__TEMPORARY_CUSTOM_HOSTNAMES: '{"iterate2.com":"iterate"}',
        APP_CONFIG_LOGIN__EMAIL_CODE__FROM: "iterate <login@iterate2.com>",
        APP_CONFIG_LOGIN__GOOGLE__CLIENT_ID: "google-id",
        APP_CONFIG_LOGIN__GOOGLE__CLIENT_SECRET: "google-secret",
        APP_CONFIG_SECRETS__PREVIOUS_KEY: "the-old-key",
        APP_CONFIG_SECRETS__ADMIN_BEARER: "admin-bearer",
        LOADER: {},
        OTHER: "ignored",
      },
      becomes: {
        urls: {
          os: "https://os.iterate2.com",
          mcp: "https://mcp.iterate2.com",
          dash: "https://dash.iterate2.com",
          ingressRouting: { type: "subdomains", hostname: "iterate2.app" },
          temporaryCustomHostnames: { "iterate2.com": "iterate" },
        },
        login: {
          password: "password",
          emailCode: { from: "iterate <login@iterate2.com>" },
          google: { clientId: "google-id", clientSecret: "google-secret" },
        },
        secrets: { key: "secrets-key", previousKey: "the-old-key", adminBearer: "admin-bearer" },
        deployId: "unversioned",
      },
    },
    // the ingress routing, narrowed: paths carry no hostname, subdomains must; the type is one of two
    {
      vars: { ...MINIMAL, APP_CONFIG_URLS__INGRESS_ROUTING__TYPE: "paths" },
      becomes: {
        ...MINIMAL_CONFIG,
        urls: { ...MINIMAL_CONFIG.urls, ingressRouting: { type: "paths" } },
      },
    },
    {
      vars: { ...MINIMAL, APP_CONFIG_URLS__INGRESS_ROUTING__TYPE: "subdomains" },
      throws:
        /^APP_CONFIG urls\.ingressRouting\.hostname \(APP_CONFIG_URLS__INGRESS_ROUTING__HOSTNAME\): expected a DNS name/,
    },
    {
      vars: {
        ...MINIMAL,
        APP_CONFIG_URLS__INGRESS_ROUTING: '{"type":"subdomains","hostname":"not a host"}',
      },
      throws: /urls\.ingressRouting\.hostname .*expected a DNS name/,
    },
    {
      vars: {
        ...MINIMAL,
        APP_CONFIG_URLS__INGRESS_ROUTING: '{"type":"paths","hostname":"iterate2.app"}',
      },
      throws: /urls\.ingressRouting\.hostname .*not for "paths"/,
    },
    {
      vars: { ...MINIMAL, APP_CONFIG_URLS__INGRESS_ROUTING__TYPE: "wildcards" },
      throws: /urls\.ingressRouting\.type .*expected "subdomains" or "paths"/,
    },
    // a mechanism to sign in with is required — a deployment nobody can sign in to is refused at boot
    {
      vars: { APP_CONFIG_SECRETS__KEY: "secrets-key" },
      throws: /^APP_CONFIG login \(APP_CONFIG_LOGIN\): no sign-in mechanism/,
    },
    {
      vars: { APP_CONFIG_SECRETS__KEY: "secrets-key", APP_CONFIG_LOGIN__PASSWORD: "  " },
      throws: /no sign-in mechanism/,
    },
    // one of the other two mechanisms alone is enough
    {
      vars: {
        APP_CONFIG_SECRETS__KEY: "secrets-key",
        APP_CONFIG_LOGIN__EMAIL_CODE__FROM: "iterate <login@iterate2.com>",
      },
      becomes: {
        ...MINIMAL_CONFIG,
        login: { password: "", emailCode: { from: "iterate <login@iterate2.com>" } },
      },
    },
    {
      vars: {
        APP_CONFIG_SECRETS__KEY: "secrets-key",
        APP_CONFIG_LOGIN__CLOUDFLARE__CLIENT_ID: "cf-id",
        APP_CONFIG_LOGIN__CLOUDFLARE__CLIENT_SECRET: "cf-secret",
      },
      becomes: {
        ...MINIMAL_CONFIG,
        login: { password: "", cloudflare: { clientId: "cf-id", clientSecret: "cf-secret" } },
      },
    },
    {
      vars: { ...MINIMAL, APP_CONFIG_LOGIN__CLOUDFLARE__CLIENT_ID: "cf-id" },
      throws: /login\.cloudflare\.clientSecret .*required, but unset or blank/,
    },
    // Google is both halves or neither
    {
      vars: { ...MINIMAL, APP_CONFIG_LOGIN__GOOGLE__CLIENT_ID: "google-id" },
      throws:
        /^APP_CONFIG login\.google\.clientSecret \(APP_CONFIG_LOGIN__GOOGLE__CLIENT_SECRET\): required, but unset or blank$/,
    },
    // the key encrypts every project secret and signs every session: a blank one is refused at
    // first use, not a silent lock-out
    {
      vars: { APP_CONFIG_LOGIN__PASSWORD: "password" },
      throws: /^APP_CONFIG secrets\.key \(APP_CONFIG_SECRETS__KEY\): required, but unset or blank$/,
    },
    {
      vars: { ...MINIMAL, APP_CONFIG_SECRETS__KEY: "  " },
      throws: /^APP_CONFIG secrets\.key \(APP_CONFIG_SECRETS__KEY\): required, but unset or blank$/,
    },
    // a wrangler var may be a JSON object; the config parser only reads STRING vars, so a non-string
    // is ignored — the field is then unset, and its required-ness is what's refused
    {
      vars: { ...MINIMAL, APP_CONFIG_SECRETS__KEY: { not: "a string" } },
      throws: /^APP_CONFIG secrets\.key \(APP_CONFIG_SECRETS__KEY\): required, but unset or blank$/,
    },
    // the MCP origin, when set, is its own origin without a path
    {
      vars: {
        ...MINIMAL,
        APP_CONFIG_URLS__OS: "https://os.test",
        APP_CONFIG_URLS__MCP: "https://mcp.test/path",
      },
      throws: /urls\.mcp .*origin/,
    },
    {
      vars: {
        ...MINIMAL,
        APP_CONFIG_URLS__OS: "https://os.test",
        APP_CONFIG_URLS__MCP: "https://os.test",
      },
      throws: /^APP_CONFIG urls\.mcp \(APP_CONFIG_URLS__MCP\): must differ from urls\.os$/,
    },
    // a key the schema does not name — a typo inside the object, a stray var (the retired token
    // secret a deployed worker may still carry) — is WARNED about loudly and dropped; the rest parses
    {
      vars: {
        APP_CONFIG: JSON.stringify({
          login: { password: "password", bogus: 1 },
          secrets: { key: "secrets-key" },
          nope: {},
        }),
      },
      becomes: MINIMAL_CONFIG,
      warns: 2,
    },
    {
      vars: { ...MINIMAL, APP_CONFIG_PROJECT_TOKEN_SECRET: "retired" },
      becomes: MINIMAL_CONFIG,
      warns: 2,
    },
  ];
  for (const { vars, becomes, throws, warns } of rows)
    test(`${JSON.stringify(vars)} → ${throws ? `throws ${throws}` : JSON.stringify(becomes)}`, () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        if (throws) expect(() => parseAppConfig(vars)).toThrow(throws);
        else expect(expose(parseAppConfig(vars))).toEqual(becomes);
        if (warns !== undefined) expect(warn).toHaveBeenCalledTimes(warns);
        else expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });
  test("the deploy id is handed in", () => {
    expect(parseAppConfig(MINIMAL, "v-123").deployId).toBe("v-123");
  });
});

describe("the derived keys", () => {
  test("the session-signing secret derives from the key under its own label: hex, stable per config, another key another secret, never the key itself", async () => {
    const config = parseAppConfig(MINIMAL);
    const secret = await sessionSigningSecretOf(config);
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(await sessionSigningSecretOf(config)).toBe(secret);
    expect(await sessionSigningSecretOf(parseAppConfig(MINIMAL))).toBe(secret);
    expect(
      await sessionSigningSecretOf(
        parseAppConfig({ ...MINIMAL, APP_CONFIG_SECRETS__KEY: "other" }),
      ),
    ).not.toBe(secret);
    expect(secret).not.toBe(config.secrets.key.exposeSecret());
  });
  test("the at-rest keys carry the previous one only while rotating", () => {
    expect(atRestKeysOf(parseAppConfig(MINIMAL))).toEqual({ current: "secrets-key" });
    expect(
      atRestKeysOf(parseAppConfig({ ...MINIMAL, APP_CONFIG_SECRETS__PREVIOUS_KEY: "the-old-key" })),
    ).toEqual({ current: "secrets-key", previous: "the-old-key" });
  });
});

describe("public protocol origins", () => {
  const origins = {
    ...MINIMAL,
    APP_CONFIG_URLS__OS: "https://os.iterate2.com",
    APP_CONFIG_URLS__MCP: "https://mcp.iterate2.com",
  };
  /** The two bindings the edge touches before it answers a public door: the directory D1, whose
   *  schema the worker applies at boot (a no-op here — these rows never reach the directory), and
   *  the assets binding the issuer's pages come from (one placeholder page). */
  const bindings = {
    // the boot-time schema (directory.ts): one batch of prepared statements, none of which matter here
    DB: { prepare: () => ({}), batch: async () => [] },
    ASSETS: { fetch: async () => new Response("<!doctype html>the page") },
  };
  const request = (url: string, env: Record<string, unknown> = origins) =>
    worker.fetch(
      new Request(url),
      { ...bindings, ...env } as unknown as Env,
      { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
    );

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
      authorization_endpoint: "https://os.iterate2.com/oauth2/auth",
      token_endpoint: "https://os.iterate2.com/oauth2/token",
    });
  });

  test("with its own origin configured, /mcp on the platform origin sends the caller there — a 308, so a client's POST survives the hop", async () => {
    const moved = await request("https://os.iterate2.com/mcp");
    expect(moved.status).toBe(308);
    expect(moved.headers.get("location")).toBe("https://mcp.iterate2.com/");
  });

  test("MCP does not acquire a Cap'n Web or console route", async () => {
    expect((await request("https://mcp.iterate2.com/api")).status).toBe(404);
    expect((await request("https://mcp.iterate2.com/login")).status).toBe(404);
    expect((await request("https://unconfigured.example/api")).status).toBe(421);
  });

  test("/version is `<deployId> <platformOrigin>` — the configured issuer, or the request's own origin where none is configured", async () => {
    expect((await (await request("https://os.iterate2.com/version")).text()).trim()).toBe(
      "unversioned https://os.iterate2.com",
    );
    // no `urls.os`: a deployment with one hostname (workers.dev) — the issuer is whatever it is called
    expect(
      (await (await request("https://iterate.someorg.workers.dev/version", MINIMAL)).text()).trim(),
    ).toBe("unversioned https://iterate.someorg.workers.dev");
    expect(
      await (
        await request(
          "https://iterate.someorg.workers.dev/.well-known/oauth-authorization-server",
          MINIMAL,
        )
      ).json(),
    ).toMatchObject({ issuer: "https://iterate.someorg.workers.dev" });
  });

  test("under path routing the platform's own paths are never a project (projects live under /projects/): the doors answer as themselves", async () => {
    const paths = {
      ...MINIMAL,
      APP_CONFIG_URLS__OS: "https://os.test",
      APP_CONFIG_URLS__INGRESS_ROUTING__TYPE: "paths",
    };
    // the bearer challenges (no session, no project lookup, no 421)
    for (const door of ["/api", "/mcp"]) {
      const answer = await request(`https://os.test${door}`, paths);
      expect(answer.status, door).toBe(401);
      expect(answer.headers.get("www-authenticate"), door).toBeTruthy();
    }
    expect((await request("https://os.test/version", paths)).status).toBe(200);
    expect(
      await (await request("https://os.test/.well-known/oauth-authorization-server", paths)).json(),
    ).toMatchObject({
      issuer: "https://os.test",
      authorization_endpoint: "https://os.test/oauth2/auth",
    });
    // the pages: sign-in and consent are the issuer's, never a project's (projects live under
    // `/projects/`) — the page, or a redirect to it, not a 421 and not a project lookup
    expect((await request("https://os.test/login", paths)).status).toBe(200);
    const consent = await request("https://os.test/oauth2/auth?client_id=x", paths);
    expect(consent.status).toBe(303); // no session: sign in first, and come back
    expect(consent.headers.get("location")).toMatch(/^\/login\?next=/);
  });
});

describe("appConfigOf — once per env object", () => {
  test("reads the version-metadata binding, blank ⇒ unversioned, and memoizes on the env", () => {
    const deployed = { ...MINIMAL, CF_VERSION_METADATA: { id: "v-9" } };
    const local = { ...MINIMAL, CF_VERSION_METADATA: { id: "" } };
    const bare = { ...MINIMAL_BLOB };
    expect(expose(appConfigOf(deployed))).toEqual({ ...MINIMAL_CONFIG, deployId: "v-9" });
    expect(expose(appConfigOf(local))).toEqual(MINIMAL_CONFIG);
    expect(expose(appConfigOf(bare))).toEqual(MINIMAL_CONFIG);
    expect(appConfigOf(deployed)).toBe(appConfigOf(deployed)); // the same object, parsed once
    expect(appConfigOf(deployed)).not.toBe(appConfigOf(local));
  });
  test("a malformed field throws at first use, naming it", () => {
    expect(() => appConfigOf({ ...MINIMAL, APP_CONFIG_SECRETS__KEY: "" })).toThrow(
      /^APP_CONFIG secrets\.key \(APP_CONFIG_SECRETS__KEY\): required, but unset or blank$/,
    );
  });
});

// ── custom hostname ── a deployment's own hostname that IS a project's apex (`app: null`, the config
// worker's fetch): the map's spelling, case and a trailing dot forgiven, anything else null.
const customHostnames = { "iterate2.com": "iterate" };
const customRows: { hostname: string; becomes: ReturnType<typeof customProjectHostOf> }[] = [
  { hostname: "iterate2.com", becomes: { app: null, project: "iterate" } },
  { hostname: "Iterate2.COM.", becomes: { app: null, project: "iterate" } },
  { hostname: "www.iterate2.com", becomes: null }, // only the hostnames named — no wildcard under them
  { hostname: "iterate.iterate2.app", becomes: null }, // the ingress's own shapes are project-ingress.ts's
  { hostname: "os.iterate2.com", becomes: null },
];
for (const { hostname, becomes } of customRows)
  test(`custom hostname ${hostname} ⇒ ${JSON.stringify(becomes)}`, () => {
    expect(customProjectHostOf(hostname, customHostnames)).toEqual(becomes);
  });
