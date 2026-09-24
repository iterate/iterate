// worker.test.ts — the edge's pure halves as tables: the app config (what the one object becomes,
// what is refused by name, the per-env memo, the derived keys), the platform's own endpoints (the public
// protocol origins, `/version`, and under path routing the platform's own paths never a project).
// The ingress convention itself (subdomains, paths, custom hostnames) is the SDK's project-ingress
// module and its own table.

import { inspect } from "node:util";
import { expect, test, vi } from "vitest";
// Routing is under test here: the unit project aliases Start's generated server entry to a stand-in
// page (src/test/start-server-entry-shim.ts); the real entry is exercised by the built-Worker and
// browser suites, where its Vite virtual modules exist.
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

const appConfigRows: {
  vars: Record<string, unknown>;
  becomes?: unknown;
  throws?: RegExp;
  /** how many unknown keys the boot warns about, once each (a key inside the object or a stray
   *  var) */
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
      APP_CONFIG_URLS__OS: "https://os.iterate.com",
      APP_CONFIG_URLS__MCP: "https://mcp.iterate.com",
      APP_CONFIG_URLS__DASH: "https://dash.iterate.com",
      APP_CONFIG_URLS__INGRESS_ROUTING: '{"type":"subdomains","hostname":"Iterate.app"}',
      APP_CONFIG_URLS__TEMPORARY_CUSTOM_HOSTNAMES: '{"iterate.com":"iterate"}',
      APP_CONFIG_URLS__PROJECT_WILDCARD: '{"hostname":"Iterate.com","project":"iterate"}',
      APP_CONFIG_LOGIN__EMAIL_CODE__FROM: "iterate <login@iterate.com>",
      APP_CONFIG_LOGIN__GOOGLE__CLIENT_ID: "google-id",
      APP_CONFIG_LOGIN__GOOGLE__CLIENT_SECRET: "google-secret",
      APP_CONFIG_SECRETS__PREVIOUS_KEY: "the-old-key",
      APP_CONFIG_SECRETS__ADMIN_BEARER: "admin-bearer",
      LOADER: {},
      OTHER: "ignored",
    },
    becomes: {
      urls: {
        os: "https://os.iterate.com",
        mcp: "https://mcp.iterate.com",
        dash: "https://dash.iterate.com",
        ingressRouting: { type: "subdomains", hostname: "iterate.app" },
        temporaryCustomHostnames: { "iterate.com": "iterate" },
        projectWildcard: { hostname: "iterate.com", project: "iterate" },
      },
      login: {
        password: "password",
        emailCode: { from: "iterate <login@iterate.com>" },
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
      APP_CONFIG_URLS__INGRESS_ROUTING: '{"type":"paths","hostname":"iterate.app"}',
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
      APP_CONFIG_LOGIN__EMAIL_CODE__FROM: "iterate <login@iterate.com>",
    },
    becomes: {
      ...MINIMAL_CONFIG,
      login: { password: "", emailCode: { from: "iterate <login@iterate.com>" } },
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
  // a key the schema does not name — a typo inside the object, a stray var — is WARNED about
  // loudly and dropped; the rest parses
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
    warns: 1,
  },
  // an override merges INTO the object's block rather than replacing it; a JSON-looking value
  // (object, array, boolean) is parsed, anything else is the string itself
  // a record's keys are the deployment's own, never warned about
  {
    vars: { ...MINIMAL, APP_CONFIG_URLS__TEMPORARY_CUSTOM_HOSTNAMES__EXAMPLE: "example" },
    becomes: {
      ...MINIMAL_CONFIG,
      urls: { ...MINIMAL_CONFIG.urls, temporaryCustomHostnames: { example: "example" } },
    },
  },
  {
    vars: {
      APP_CONFIG: JSON.stringify({
        urls: { os: "https://os.test", mcp: "https://mcp.test" },
        login: { password: "password" },
        secrets: { key: "secrets-key" },
      }),
      APP_CONFIG_URLS__PROJECT_WILDCARD:
        '{"hostname":"iterate.com","project":"iterate","excludedHostnames":["www.iterate.com"]}',
      APP_CONFIG_URLS__TEMPORARY_CUSTOM_HOSTNAMES: '{"iterate.com":"iterate"}',
    },
    becomes: {
      ...MINIMAL_CONFIG,
      urls: {
        ...MINIMAL_CONFIG.urls,
        os: "https://os.test",
        mcp: "https://mcp.test",
        temporaryCustomHostnames: { "iterate.com": "iterate" },
        projectWildcard: {
          hostname: "iterate.com",
          project: "iterate",
          excludedHostnames: ["www.iterate.com"],
        },
      },
    },
  },
  // the object must be a JSON object
  { vars: { ...MINIMAL, APP_CONFIG: "{not json" }, throws: /^APP_CONFIG must be valid JSON$/ },
  { vars: { ...MINIMAL, APP_CONFIG: "[]" }, throws: /^APP_CONFIG must be a JSON object$/ },
];
for (const { vars, becomes, throws, warns } of appConfigRows)
  test(`parseAppConfig: ${JSON.stringify(vars)} → ${throws ? `throws ${throws}` : JSON.stringify(becomes)}`, () => {
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
test("parseAppConfig: a secret never prints", () => {
  const { secrets } = parseAppConfig(MINIMAL);
  expect(String(secrets.key)).toBe("REDACTED");
  expect(JSON.stringify(secrets)).not.toContain("secrets-key");
  expect(inspect(secrets.key)).toBe("Redacted {}");
  expect(secrets.key.exposeSecret()).toBe("secrets-key");
});
test("parseAppConfig: the deploy id is handed in", () => {
  expect(parseAppConfig(MINIMAL, "v-123")).toMatchObject({ deployId: "v-123" });
});

test("the derived keys: the session-signing secret derives from the key under its own label: hex, stable per config, another key another secret, never the key itself", async () => {
  const config = parseAppConfig(MINIMAL);
  const secret = await sessionSigningSecretOf(config);
  expect(secret).toMatch(/^[0-9a-f]{64}$/);
  expect(await sessionSigningSecretOf(config)).toBe(secret);
  expect(await sessionSigningSecretOf(parseAppConfig(MINIMAL))).toBe(secret);
  expect(
    await sessionSigningSecretOf(parseAppConfig({ ...MINIMAL, APP_CONFIG_SECRETS__KEY: "other" })),
  ).not.toBe(secret);
  expect(secret).not.toBe(config.secrets.key.exposeSecret());
});
test("the derived keys: the at-rest keys carry the previous one only while rotating", () => {
  expect(atRestKeysOf(parseAppConfig(MINIMAL))).toEqual({ current: "secrets-key" });
  expect(
    atRestKeysOf(parseAppConfig({ ...MINIMAL, APP_CONFIG_SECRETS__PREVIOUS_KEY: "the-old-key" })),
  ).toEqual({ current: "secrets-key", previous: "the-old-key" });
});

const origins = {
  ...MINIMAL,
  APP_CONFIG_URLS__OS: "https://os.iterate.com",
  APP_CONFIG_URLS__MCP: "https://mcp.iterate.com",
};
/** The bindings the edge touches before it answers a public route: the registry namespace the
 *  control plane's edge is built over (`ControlPlane`, src/control-plane/edge.ts — the singleton's
 *  stub is taken, never dialled: these rows never reach the catalog), the context namespace, and
 *  the assets binding the issuer's pages come from (one placeholder page). */
const bindings = {
  CONTROL_PLANE: { getByName: () => ({}) },
  ITERATE_CONTEXT: { getByName: () => ({}) },
  ASSETS: { fetch: async () => new Response("<!doctype html>the page") },
};

test("public protocol origins: MCP discovery uses its public origin and the platform's issuer", async () => {
  const denied = await request("https://mcp.iterate.com/");
  expect(denied).toMatchObject({ status: 401 });
  const metadataUrl = /resource_metadata="([^"]+)"/.exec(
    denied.headers.get("www-authenticate")!,
  )![1]!;
  expect(metadataUrl).toMatch(/^https:\/\/mcp\.iterate\.com\//);
  expect(await (await request(metadataUrl)).json()).toMatchObject({
    resource: "https://mcp.iterate.com/",
    authorization_servers: ["https://os.iterate.com"],
  });
  expect(
    await (await request("https://os.iterate.com/.well-known/oauth-authorization-server")).json(),
  ).toMatchObject({
    issuer: "https://os.iterate.com",
    authorization_endpoint: "https://os.iterate.com/oauth2/auth",
    token_endpoint: "https://os.iterate.com/oauth2/token",
  });
});

test("public protocol origins: with its own origin configured, /mcp on the platform origin sends the caller there — a 308, so a client's POST survives the hop", async () => {
  const moved = await request("https://os.iterate.com/mcp");
  expect(moved).toMatchObject({ status: 308 });
  expect(moved.headers.get("location")).toBe("https://mcp.iterate.com/");
});

test("public protocol origins: MCP does not acquire a Cap'n Web or console route", async () => {
  expect(await request("https://mcp.iterate.com/api")).toMatchObject({ status: 404 });
  expect(await request("https://mcp.iterate.com/login")).toMatchObject({ status: 404 });
  expect(await request("https://unconfigured.example/api")).toMatchObject({ status: 421 });
});

test("public protocol origins: /version is `<deployId> <platformOrigin>` — the configured issuer, or the request's own origin where none is configured", async () => {
  expect((await (await request("https://os.iterate.com/version")).text()).trim()).toBe(
    "unversioned https://os.iterate.com",
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

test("public protocol origins: the issuer stays on the control plane when its zone also has a project wildcard", async () => {
  const response = await request("https://os.iterate.com/version", {
    ...origins,
    APP_CONFIG_URLS__PROJECT_WILDCARD: '{"hostname":"iterate.com","project":"iterate"}',
  });
  expect(response).toMatchObject({ status: 200 });
  expect(await response.text()).toBe("unversioned https://os.iterate.com\n");
});

test("public protocol origins: under path routing the platform's own paths are never a project (projects live under /projects/): its endpoints answer as themselves", async () => {
  const paths = {
    ...MINIMAL,
    APP_CONFIG_URLS__OS: "https://os.test",
    APP_CONFIG_URLS__INGRESS_ROUTING__TYPE: "paths",
  };
  // the bearer challenges (no session, no project lookup, no 421)
  for (const endpoint of ["/api", "/mcp"]) {
    const answer = await request(`https://os.test${endpoint}`, paths);
    expect(answer, endpoint).toMatchObject({ status: 401 });
    expect(answer.headers.get("www-authenticate"), endpoint).toBeTruthy();
  }
  expect(await request("https://os.test/version", paths)).toMatchObject({ status: 200 });
  expect(
    await (await request("https://os.test/.well-known/oauth-authorization-server", paths)).json(),
  ).toMatchObject({
    issuer: "https://os.test",
    authorization_endpoint: "https://os.test/oauth2/auth",
  });
  // the pages: sign-in and consent are the issuer's, never a project's (projects live under
  // `/projects/`) — the page, or a redirect to it, not a 421 and not a project lookup
  expect(await request("https://os.test/login", paths)).toMatchObject({ status: 200 });
  // the consent page is a Start route too (its sign-in redirect is issuer-bootstrap.test.ts's)
  expect(await request("https://os.test/oauth2/auth?client_id=x", paths)).toMatchObject({
    status: 200,
  });
});

test("public protocol origins: the issuer's pages admit only their own methods, HTML requests and same-origin posts", async () => {
  const page = (path: string, init?: RequestInit) =>
    worker.fetch(
      new Request(`https://os.iterate.com${path}`, init),
      { ...bindings, ...origins } as unknown as Env,
      { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
    );
  expect(await page("/login")).toMatchObject({ status: 200 });
  expect(await page("/login", { headers: { accept: "application/json" } })).toMatchObject({
    status: 406,
  });
  expect(await page("/", { method: "POST" })).toMatchObject({ status: 405 });
  expect(await page("/login", { method: "DELETE" })).toMatchObject({ status: 405 });
  const crossSite = { method: "POST", headers: { origin: "https://evil.example" } };
  expect(await page("/login", crossSite)).toMatchObject({ status: 403 });
  expect(await page("/oauth2/auth?client_id=x", crossSite)).toMatchObject({ status: 403 });
  // the public files beside the pages, and nothing else
  expect(await page("/issuer.css")).toMatchObject({ status: 200 });
  expect(await page("/client-logos/browser-extension.svg")).toMatchObject({ status: 200 });
  expect(await page("/authorize.js")).toMatchObject({ status: 404 });
  expect(await page("/capnweb.js")).toMatchObject({ status: 404 });
});

test("appConfigOf — once per env object: reads the version-metadata binding, blank ⇒ unversioned, and memoizes on the env", () => {
  const deployed = { ...MINIMAL, CF_VERSION_METADATA: { id: "v-9" } };
  const local = { ...MINIMAL, CF_VERSION_METADATA: { id: "" } };
  const bare = { ...MINIMAL_BLOB };
  expect(expose(appConfigOf(deployed))).toEqual({ ...MINIMAL_CONFIG, deployId: "v-9" });
  expect(expose(appConfigOf(local))).toEqual(MINIMAL_CONFIG);
  expect(expose(appConfigOf(bare))).toEqual(MINIMAL_CONFIG);
  expect(appConfigOf(deployed)).toBe(appConfigOf(deployed)); // the same object, parsed once
  expect(appConfigOf(deployed)).not.toBe(appConfigOf(local));
});
test("appConfigOf — once per env object: a malformed field throws at first use, naming it", () => {
  expect(() => appConfigOf({ ...MINIMAL, APP_CONFIG_SECRETS__KEY: "" })).toThrow(
    /^APP_CONFIG secrets\.key \(APP_CONFIG_SECRETS__KEY\): required, but unset or blank$/,
  );
});

/** A public route's answer from the edge over `bindings` and `env` (the origins by default). */
const request = (url: string, env: Record<string, unknown> = origins) =>
  worker.fetch(
    new Request(url),
    { ...bindings, ...env } as unknown as Env,
    { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
  );

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
