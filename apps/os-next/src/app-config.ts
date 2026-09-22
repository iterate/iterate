// ── app config ── THE WORKER'S CONFIGURATION: ONE JSON object per deployment — the `APP_CONFIG`
// Worker secret — parsed once per isolate by the shared env parser (`@iterate-com/shared/config`),
// plus the platform-supplied deploy identity (the version-metadata binding). Loud on anything
// malformed, at first use — never a silent default.
//
// Configuration is what differs between deployments of the SAME code. A constant (a timeout, a
// budget, the AI Gateway's name, the loaded-worker compatibility flags) is a property of the code and
// lives beside its consumer. The object's keys are the schema's own names, nested as the schema is:
//
//   {
//     urls: { os, mcp, dash, ingressRouting: { type, hostname }, temporaryCustomHostnames: {} },
//     login: { password, emailCode: { from }, google: { clientId, clientSecret }, cloudflare: { clientId, clientSecret } },
//     secrets: { key, previousKey, adminBearer },
//   }
//
// Any key can also be set ALONE as a var, the path joined by `__`: `APP_CONFIG_URLS__OS`,
// `APP_CONFIG_LOGIN__PASSWORD`, `APP_CONFIG_SECRETS__KEY` — the parser merges it on top of the object
// (that is how a deployment's `urls` come from envs.ts while its secrets come from the one blob, and
// how `secrets.key` stands alone as its own Worker secret so it can rotate with `previousKey` beside
// it). A blank var is unset. A key the schema does not name is warned about loudly at boot and
// dropped, never silently kept.

import { compileRawAppConfigFromEnv, redacted, type Redacted } from "@iterate-com/shared/config";
import { z } from "zod";
import type { IngressRouting } from "iterate/next/project-ingress";

/** A field's failure message names the SHAPE; `parseAppConfig` prefixes where it came from. */
const REQUIRED = "required, but unset or blank";

/** An HTTP(S) origin with no path or query — `new URL(v).origin === v`. */
const httpOrigin = z
  .string()
  .trim()
  .refine((value) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    return url.origin === value && (url.protocol === "https:" || url.protocol === "http:");
  }, "expected an HTTP(S) origin without a path");

/** An origin a deployment may leave out (blank ⇒ the documented default). */
const optionalOrigin = z.union([z.literal(""), httpOrigin]).default("");

/** A DNS name: lowercase labels, no scheme, no trailing dot, no wildcard — the wildcard is implied. */
const dnsName = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)*$/, "expected a DNS name");

/** THE `APP_CONFIG` SCHEMA — PER-FIELD validation only; the cross-field rules (a distinct MCP origin,
 *  the ingress routing's hostname, at least one sign-in mechanism) live in `parseAppConfig`, because
 *  the shared env parser needs plain object schemas to check override keys against. Every object
 *  `prefault`s to `{}` so a deployment that names none of a block's keys still gets the block. */
export const AppConfig = z.object({
  /** Where this deployment answers. Every one optional. */
  urls: z
    .object({
      /** THE ISSUER — the OAuth issuer identifier, the `__Host-` cookie's origin, what resource tokens
       *  are bound to. Blank ⇒ each request's own origin (a deployment with one hostname, workers.dev). */
      os: optionalOrigin,
      /** A separate MCP origin. Blank ⇒ `/mcp` on `urls.os`. */
      mcp: optionalOrigin,
      /** The dash (apps/dash) — where the landing page (`/`, control-plane.ts) sends a person, this
       *  origin being headless. Blank ⇒ the page names no dash. */
      dash: optionalOrigin,
      /** How projects are reached over HTTP (project-ingress.ts): `subdomains` hangs
       *  `<app>--<project>.<hostname>` and the apex `<project>.<hostname>` under a wildcard on
       *  `hostname`; `paths` serves `<urls.os>/projects/<project>/<app>/…` from the one origin. Unset ⇒ no
       *  ingress: `/api` and `/mcp` still answer, no app has an HTTP door. */
      ingressRouting: z
        .object({
          type: z.enum(["subdomains", "paths"], { error: 'expected "subdomains" or "paths"' }),
          /** `subdomains` only: the hostname the wildcard is on. */
          hostname: z.string().trim().default(""),
        })
        .optional(),
      /** TEMPORARY — hostnames of this deployment's own that ARE a project's apex
       *  (`{ "iterate2.com": "iterate" }`): a request there lands on that project's config worker
       *  `fetch` exactly as `<project>.<hostname>` does; the route and the DNS record are the
       *  deployment's (envs.ts). This belongs in the project's own runtime config, not the platform's. */
      temporaryCustomHostnames: z.record(dnsName, z.string().trim().min(1, REQUIRED)).default({}),
    })
    .prefault({}),
  /** How a person signs in. Each mechanism is on iff its block is present; `parseAppConfig` refuses a
   *  deployment with none (nobody could ever sign in). */
  login: z
    .object({
      /** A GLOBAL PASSWORD: anyone who knows it signs in as the email they type — the membership is
       *  the password, the email is the name tag. The self-host default; also how the specs sign in.
       *  Blank ⇒ off. */
      password: redacted(z.string().trim().default("")),
      /** A six-digit code mailed through the `EMAIL` binding (login-code.ts) from `from`, an address on
       *  a domain onboarded for Email Sending in the deployment's account. */
      emailCode: z
        .object({ from: z.string({ error: REQUIRED }).trim().min(1, REQUIRED) })
        .optional(),
      /** Google sign-in (identity.ts): the OAuth client, both halves. */
      google: z
        .object({
          clientId: z.string({ error: REQUIRED }).trim().min(1, REQUIRED),
          clientSecret: redacted(z.string({ error: REQUIRED }).trim().min(1, REQUIRED)),
        })
        .optional(),
      /** Cloudflare sign-in uses our own OAuth client, independently of deployment grants. */
      cloudflare: z
        .object({
          clientId: z.string({ error: REQUIRED }).trim().min(1, REQUIRED),
          clientSecret: redacted(z.string({ error: REQUIRED }).trim().min(1, REQUIRED)),
        })
        .optional(),
    })
    .prefault({}),
  /** The deployment's own keys. */
  secrets: z
    .object({
      /** THE KEY. Project secrets' material at rest is encrypted under it (secret-at-rest.ts, the AES
       *  key its SHA-256), and the session-signing secret derives from it under a label
       *  (`sessionSigningSecretOf`). Any string. Losing it loses every stored secret's material (the
       *  catalog survives; each secret is set again) and signs every session out. */
      key: redacted(z.string({ error: REQUIRED }).trim().min(1, REQUIRED)),
      /** The key before a rotation, decrypt-only: a record it opens is written back under `key` on that
       *  read, so it can be dropped once every record has been read once. Blank when not rotating. */
      previousKey: redacted(z.string().trim().default("")),
      /** THE OPERATOR'S BEARER — `authenticate({ type: "admin-secret" })` on `/api` (every project, `as`
       *  a user without a login) and a bearer on `/mcp`: the deployed specs, CI, tooling. Blank ⇒ no
       *  operator door (a self-host needs none: a personal access token covers scripting). */
      adminBearer: redacted(z.string().trim().default("")),
    })
    // the prefault must satisfy the input type; `key: ""` then fails `min(1)` naming secrets.key
    .prefault({ key: "" }),
});

/** THE WORKER'S CONFIGURATION: the parsed object (secrets as `Redacted`), the ingress routing
 *  narrowed to the SDK's `IngressRouting` (`subdomains` always carries its hostname), the deploy
 *  identity folded in. */
export type AppConfig = Omit<z.output<typeof AppConfig>, "urls"> & {
  readonly urls: Omit<z.output<typeof AppConfig>["urls"], "ingressRouting"> & {
    readonly ingressRouting: IngressRouting;
  };
  /** Cloudflare's version id of the running deployment (`CF_VERSION_METADATA.id`; local workerd mints
   *  one too); "unversioned" where the binding is absent or blank. In every loader cacheKey and at
   *  `/version`. */
  readonly deployId: string;
};

/** The slice of `env` the configuration reads: the version-metadata binding, the `APP_CONFIG` object
 *  and the `APP_CONFIG_*` overrides, each an optional string. The worker's `Env` extends this. */
export type AppConfigEnv = { CF_VERSION_METADATA?: { id: string }; APP_CONFIG?: string } & {
  [Name in `APP_CONFIG_${string}`]?: string;
};

/** The override var a schema path answers to — `["urls", "os"]` → `APP_CONFIG_URLS__OS` — the inverse
 *  of the shared parser's mapping, so a boot error names both spellings a human might have used. */
function envVarNameOf(path: readonly (string | number | symbol)[]): string {
  return `APP_CONFIG_${path
    .map((segment) =>
      String(segment)
        .replace(/([A-Z])/g, "_$1")
        .toUpperCase(),
    )
    .join("__")}`;
}

/** Where a field came from, for a message: its path in the object and its var spelling. */
function fieldNameOf(path: readonly (string | number | symbol)[]): string {
  return `APP_CONFIG ${path.map(String).join(".")} (${envVarNameOf(path)})`;
}

/** Warn, loudly, about a key the schema does not name — the shared parser does this for the
 *  `APP_CONFIG_*` overrides; this does it for the object itself, which reaches the schema whole. Walks
 *  the plain objects only; a record accepts any key. */
function warnUnknownKeys(raw: unknown, schema: z.ZodTypeAny, path: string[]): void {
  const object = z.record(z.string(), z.unknown()).safeParse(raw);
  if (!object.success) return;
  let current: z.ZodTypeAny = schema;
  while (
    current instanceof z.ZodDefault ||
    current instanceof z.ZodPrefault ||
    current instanceof z.ZodOptional
  )
    current = current.unwrap() as z.ZodTypeAny;
  if (!(current instanceof z.ZodObject)) return;
  for (const [key, value] of Object.entries(object.data)) {
    const child = current.shape[key] as z.ZodTypeAny | undefined;
    if (!child) {
      console.warn(
        `APP_CONFIG: unknown key "${[...path, key].join(".")}" — not in the schema, ignored. Remove it, or add it to app-config.ts.`,
      );
      continue;
    }
    warnUnknownKeys(value, child, [...path, key]);
  }
}

/** Parse the configuration out of `env` (a worker env, or any record — only `APP_CONFIG` and the
 *  `APP_CONFIG_*` keys are read; a blank one is unset). Pure; the door every test goes through. A
 *  malformed field throws naming itself. */
export function parseAppConfig(env: object, deployId = "unversioned"): AppConfig {
  const configEnv: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!(key === "APP_CONFIG" || key.startsWith("APP_CONFIG_"))) continue;
    if (typeof value !== "string" || !value.trim()) continue;
    configEnv[key] = value;
  }
  let parsed: z.output<typeof AppConfig>;
  try {
    const raw = compileRawAppConfigFromEnv({
      configSchema: AppConfig,
      prefix: "APP_CONFIG_",
      env: configEnv,
    });
    warnUnknownKeys(raw, AppConfig, []);
    parsed = AppConfig.parse(raw);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const issue = error.issues[0]!;
      throw new Error(`${fieldNameOf(issue.path)}: ${issue.message}`);
    }
    throw error;
  }
  const { urls, login } = parsed;
  if (urls.mcp && !urls.os)
    throw new Error(
      `${fieldNameOf(["urls", "mcp"])}: a separate MCP origin needs urls.os set (with a blank urls.os every request's own origin is the platform's, and the MCP origin is not)`,
    );
  if (urls.mcp && urls.mcp === urls.os)
    throw new Error(`${fieldNameOf(["urls", "mcp"])}: must differ from urls.os`);
  let ingressRouting: IngressRouting = null;
  if (urls.ingressRouting?.type === "subdomains") {
    const hostname = dnsName.safeParse(urls.ingressRouting.hostname);
    if (!hostname.success)
      throw new Error(
        `${fieldNameOf(["urls", "ingressRouting", "hostname"])}: ${hostname.error.issues[0]!.message} (the hostname the project wildcard is on)`,
      );
    ingressRouting = { type: "subdomains", hostname: hostname.data };
  } else if (urls.ingressRouting?.type === "paths") {
    if (urls.ingressRouting.hostname)
      throw new Error(
        `${fieldNameOf(["urls", "ingressRouting", "hostname"])}: not for "paths" — projects are paths on urls.os`,
      );
    ingressRouting = { type: "paths" };
  }
  if (!login.password.exposeSecret() && !login.emailCode && !login.google && !login.cloudflare)
    throw new Error(
      `${fieldNameOf(["login"])}: no sign-in mechanism — set login.password, login.emailCode, login.google or login.cloudflare`,
    );
  return {
    ...parsed,
    urls: { ...urls, ingressRouting },
    deployId,
  };
}

const appConfigByEnv = new WeakMap<object, AppConfig>();

/** The configuration of the isolate `env` belongs to — parsed on first use, then the same object every
 *  time (a WeakMap on the env object: a worker's `env` and a DO's `this.env` are stable for the
 *  isolate's life). A malformed field throws HERE, on the first request or the first DO
 *  construction, naming the field. */
export function appConfigOf(env: AppConfigEnv): AppConfig {
  let appConfig = appConfigByEnv.get(env);
  if (!appConfig) {
    appConfig = parseAppConfig(env, env.CF_VERSION_METADATA?.id?.trim() || "unversioned");
    appConfigByEnv.set(env, appConfig);
  }
  return appConfig;
}

const sessionSigningSecretByConfig = new WeakMap<AppConfig, Promise<string>>();

/** THE SESSION-SIGNING SECRET (principal.ts `signClaims`/`verifyClaims`: the login flow's cookie, a
 *  signed file URL): `secrets.key` under its own label, SHA-256, hex — so the one key a deployment
 *  holds serves two algorithms without being reused raw (secret-at-rest.ts hashes the key under the
 *  other). Rotating the key signs every session out; a mid-rotation `previousKey` opens no session.
 *  Async (WebCrypto), computed once per config object. */
export function sessionSigningSecretOf(config: AppConfig): Promise<string> {
  let secret = sessionSigningSecretByConfig.get(config);
  if (!secret) {
    secret = crypto.subtle
      .digest(
        "SHA-256",
        new TextEncoder().encode(`iterate-session-signing:${config.secrets.key.exposeSecret()}`),
      )
      .then((digest) =>
        Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
      );
    sessionSigningSecretByConfig.set(config, secret);
  }
  return secret;
}

/** The at-rest keys as secret-at-rest.ts takes them: the key, and the previous one only while
 *  rotating. */
export function atRestKeysOf(config: AppConfig): { current: string; previous?: string } {
  const previous = config.secrets.previousKey.exposeSecret();
  return { current: config.secrets.key.exposeSecret(), previous: previous || undefined };
}

/** Where the platform answers, for the request in hand. `platformOrigin` is the origin the request
 *  reached the platform on — `urls.os` when the deployment names one (prd, a preview: more than one
 *  hostname), else the request's own origin (a self-host: one hostname, workers.dev) — and it IS the
 *  OAuth issuer identifier: the `__Host-` cookie's origin, what the issuer's pages and every composed
 *  URL hang under. `api` and `mcp` are the two resource identifiers a token is bound to, `/api` on
 *  the platform origin and the MCP root (a separate origin's `/` when `urls.mcp` names one, else
 *  `/mcp`). The edge computes them once per request and stamps every caller with the origin
 *  (`Caller.platformOrigin`); a context persists what its callers said, for the calls that carry
 *  none (a loaded worker's, an alarm's). */
export type PlatformAddresses = { platformOrigin: string; api: string; mcp: string };
export function platformAddressesOf(env: AppConfigEnv, request: Request): PlatformAddresses {
  const config = appConfigOf(env);
  const platformOrigin = config.urls.os || new URL(request.url).origin;
  return {
    platformOrigin,
    api: `${platformOrigin}/api`,
    mcp: config.urls.mcp ? `${config.urls.mcp}/` : `${platformOrigin}/mcp`,
  };
}

export type { Redacted };
