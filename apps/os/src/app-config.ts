// ── app config ── THE WORKER'S CONFIGURATION: ONE JSON object per deployment — the `APP_CONFIG`
// Worker secret — parsed once per isolate by `parseAppConfig` below, plus the platform-supplied
// deploy identity (the version-metadata binding). Loud on anything malformed, at first use — never a
// silent default.
//
// Configuration is what differs between deployments of the SAME code. A constant (a timeout, a
// budget, the AI Gateway's name, the loaded-worker compatibility flags) is a property of the code and
// lives beside its consumer. The object's keys are the schema's own names, nested as the schema is:
//
//   {
//     urls: { os, mcp, dash, ingressRouting: { type, hostname }, projectWildcard: { hostname, project, excludedHostnames } },
//     login: { allowedEmails, password, emailCode: { from }, google: { scopes }, cloudflare: { scopes }, github: {}, testLink: { emailDomain, admins: { issuer, emails } } },
//     admins,
//     customHostnames: { zone, zoneId, dcvDelegationUuid, reservedZones }, cloudflareApiToken,
//     posthogProjectKey,
//     integrations: {
//       slack: { oauthClientId, oauthClientSecret, webhookSigningSecret, scopes, slackOrigin },
//       google: { oauthClientId, oauthClientSecret, scopes, googleOrigin },
//       cloudflare: { oauthClientId, oauthClientSecret, scopes, cloudflareOrigin },
//       github: { appId, appSlug, oauthClientId, oauthClientSecret, privateKey, webhookSecret, githubOrigin },
//     },
//     secrets: { key, previousKey, adminBearer },
//   }
//
// Any key can also be set ALONE as a var, the path joined by `__`: `APP_CONFIG_URLS__OS`,
// `APP_CONFIG_LOGIN__PASSWORD`, `APP_CONFIG_SECRETS__KEY` — the parser merges it on top of the object
// (that is how a deployment's `urls` come from envs.ts while its secrets come from the one blob, and
// how `secrets.key` stands alone as its own Worker secret so it can rotate with `previousKey` beside
// it). A blank var is unset. A key the schema does not name is warned about loudly at boot and
// dropped, never silently kept. The mechanism is shared with the apps on top
// (@iterate-com/shared/app-config); this module is the platform's schema and cross-field rules.

import { z } from "zod";
import {
  dnsName,
  fieldNameOf,
  httpOrigin,
  optionalOrigin,
  parseAppConfigVars,
} from "@iterate-com/shared/app-config";
import {
  projectAddressOf,
  projectWildcardHostOf,
  type IngressRouting,
  type ProjectAddress,
} from "iterate/project-ingress";
import { sha256Hex } from "./caller.ts";
import { TEST_LINK_EMAIL_DOMAIN } from "./test-link.ts";

/** A secret config value: `exposeSecret()` hands it over; printing, logging or serialising it shows
 *  only "REDACTED", so a config dump can never leak it. */
class Redacted<T> {
  #value: T;
  constructor(value: T) {
    this.#value = value;
  }
  exposeSecret(): T {
    return this.#value;
  }
  toString(): string {
    return "REDACTED";
  }
  toJSON(): string {
    return "REDACTED";
  }
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "Redacted {}";
  }
}

function redacted<Schema extends z.ZodTypeAny>(schema: Schema) {
  return schema.transform((value): Redacted<z.output<Schema>> => new Redacted(value));
}

/** A field's failure message names the SHAPE; `parseAppConfig` prefixes where it came from. */
const REQUIRED = "required, but unset or blank";

/** Email patterns (allowed-emails.ts): `*` for any run of characters — `["*@iterate.com",
 *  "someone@example.com"]`. A JSON array, or as a var a comma-separated list too; never empty,
 *  `empty` saying why. */
const emailPatterns = (empty: string) =>
  z.preprocess(
    (value) =>
      typeof value === "string"
        ? value
            .split(",")
            .map((pattern) => pattern.trim())
            .filter(Boolean)
        : value,
    z
      .array(
        z
          .string()
          .trim()
          .toLowerCase()
          .regex(/^[^@\s]+@[^@\s]+$/, 'expected email patterns like "*@iterate.com"'),
      )
      .min(1, empty),
  );

/** The bot scopes a Slack connection asks for unless told otherwise — the legacy platform's list, so
 *  iterate's Slack app keeps asking for what its console was set up with. */
export const DEFAULT_SLACK_BOT_SCOPES = [
  "channels:history",
  "channels:join",
  "channels:manage",
  "channels:read",
  "chat:write",
  "chat:write.public",
  "files:read",
  "files:write",
  "groups:history",
  "groups:read",
  "im:history",
  "im:read",
  "im:write",
  "mpim:history",
  "mpim:read",
  "reactions:read",
  "reactions:write",
  "users.profile:read",
  "users:read",
  "users:read.email",
  "assistant:write",
  "conversations.connect:write",
] as const;

/** The scopes a Google connection asks for unless told otherwise — the legacy platform's list, so
 *  iterate's Google client keeps asking for what its consent screen was verified for. */
export const DEFAULT_GOOGLE_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.labels",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/drive",
] as const;

/** What signing in with Google asks for unless told otherwise: the identity, and the Gmail,
 *  Calendar, Docs and Drive scopes a connection asks for, so a sign-in keeps a token agents can use. */
export const DEFAULT_GOOGLE_SIGN_IN_SCOPES = [
  "openid",
  "email",
  "profile",
  ...DEFAULT_GOOGLE_SCOPES.filter(
    (scope) => scope !== "openid" && !scope.startsWith("https://www.googleapis.com/auth/userinfo."),
  ),
];

/** What signing in with Cloudflare, or connecting it, asks for unless told otherwise: the identity
 *  alone (Cloudflare returns email and email_verified with these, and rejects email/profile). A
 *  deployment whose client is registered for more (`offline_access` for a refresh token, the
 *  Workers deploy scopes) names them. */
export const DEFAULT_CLOUDFLARE_SCOPES = ["openid", "user-details.read"];

/** THE `APP_CONFIG` SCHEMA — PER-FIELD validation only; the cross-field rules (a distinct MCP origin,
 *  the ingress routing's hostname, at least one sign-in mechanism) live in `parseAppConfig`, because
 *  `warnUnknownKeys` needs plain object schemas to check keys against. Every object `prefault`s to
 *  `{}` so a deployment that names none of a block's keys still gets the block. */
export const AppConfig = z.object({
  /** Where this deployment answers. Every one optional. */
  urls: z
    .object({
      /** THE ISSUER — the OAuth issuer identifier, the `__Host-` cookie's origin, what resource tokens
       *  are bound to. Blank ⇒ each request's own origin (a deployment with one hostname, workers.dev). */
      os: optionalOrigin,
      /** A separate MCP origin. Blank ⇒ `/mcp` on `urls.os`. */
      mcp: optionalOrigin,
      /** The dash (apps/dash) — where the landing page (`/`, routes/index.tsx) sends a person, this
       *  origin being headless. Blank ⇒ the page names no dash. */
      dash: optionalOrigin,
      /** How projects are reached over HTTP (project-ingress.ts): `subdomains` hangs
       *  `<routingSlug>--<project>.<hostname>` and the apex `<project>.<hostname>` under a wildcard on
       *  `hostname`; `paths` serves `<urls.os>/projects/<project>/<routingSlug>/…` from the one origin. Unset ⇒ no
       *  ingress: `/api` and `/mcp` still answer, no app is reachable over HTTP. */
      ingressRouting: z
        .object({
          type: z.enum(["subdomains", "paths"], { error: 'expected "subdomains" or "paths"' }),
          /** `subdomains` only: the hostname the wildcard is on. */
          hostname: z.string().trim().default(""),
        })
        .optional(),
      /** This owned zone's apex and first-level names serve one project's config worker. */
      projectWildcard: z
        .object({
          hostname: dnsName,
          project: z.string().trim().min(1, REQUIRED),
          excludedHostnames: z.array(dnsName).optional(),
        })
        .optional(),
    })
    .prefault({}),
  /** CUSTOM HOSTNAMES a project adds itself (project/custom-hostnames.ts): each a wildcard
   *  Cloudflare for SaaS custom hostname on `zone`, routed by the control plane's hostname table.
   *  Unset ⇒ no project can add one. From envs.ts `cloudflareForSaas` (the generator), with the
   *  deployment's own zones as `reservedZones`: a hostname equal to or under one is refused. */
  customHostnames: z
    .object({
      zone: dnsName,
      zoneId: z.string().trim().min(1, REQUIRED),
      dcvDelegationUuid: z.string().trim().min(1, REQUIRED),
      reservedZones: z.array(dnsName).default([]),
    })
    .optional(),
  /** The deployment's Cloudflare API token, for what the worker itself asks of Cloudflare at runtime:
   *  today a project's custom hostnames (edit on `customHostnames.zone`). Blank ⇒ none; a custom
   *  hostname is then refused with that reason rather than half-provisioned. */
  cloudflareApiToken: redacted(z.string().trim().default("")),
  /** PostHog's project key (envs.ts `posthogProjectKey`, prd only): the issuer's pages start
   *  posthog-js with it (issuer.functions.ts) and every `reportIssue` becomes a `$exception` in
   *  PostHog Error Tracking (posthog.ts). A public key, not a secret. Blank ⇒ no PostHog. */
  posthogProjectKey: z.string().trim().default(""),
  /** How a person signs in. Each mechanism is on iff its block is present; `parseAppConfig` refuses a
   *  deployment with none (nobody could ever sign in). */
  login: z
    .object({
      /** WHO MAY SIGN IN (allowed-emails.ts): email patterns, `*` for any run of characters —
       *  `["*@iterate.com", "someone@example.com"]`. A JSON array, or as the var
       *  `APP_CONFIG_LOGIN__ALLOWED_EMAILS` a comma-separated list too. Every mechanism refuses an
       *  address it does not name, and a live grant for one stops working. Unset ⇒ everyone. */
      allowedEmails: emailPatterns(
        "lists no pattern, so nobody could sign in — name one, or unset it",
      ).optional(),
      /** A GLOBAL PASSWORD: anyone who knows it signs in as the email they type — the membership is
       *  the password, the email is the name tag. The self-host default; also how the specs sign in.
       *  Blank ⇒ off. */
      password: redacted(z.string().trim().default("")),
      /** A six-digit code mailed through the `EMAIL` binding (password-and-code-sign-in.ts) from `from`, an address on
       *  a domain onboarded for Email Sending in the deployment's account. */
      emailCode: z
        .object({ from: z.string({ error: REQUIRED }).trim().min(1, REQUIRED) })
        .optional(),
      /** SIGN IN WITH A PROVIDER (identity.ts), each on iff its block is present AND the provider's
       *  `integrations.<provider>` names the client: one OAuth client per provider serves signing in
       *  and connecting, because a refresh token only works with the client that issued it. A
       *  sign-in keeps its token as the person's own connection. `scopes` is what the sign-in asks
       *  for (GitHub's are the App's permissions, so it has none). */
      google: z
        .object({
          scopes: z.array(z.string().trim().min(1)).default(DEFAULT_GOOGLE_SIGN_IN_SCOPES),
        })
        .optional(),
      cloudflare: z
        .object({ scopes: z.array(z.string().trim().min(1)).default(DEFAULT_CLOUDFLARE_SCOPES) })
        .optional(),
      github: z.object({}).optional(),
      /** A PREVIEW'S ONE-CLICK SIGN-IN (test-link.ts): `GET /.auth/test-link?t=` signs a browser in
       *  as the address a link signed with this deployment's key names, under `emailDomain`. Not a
       *  sign-in mechanism a person chooses, and refused (`parseAppConfig`) unless `urls.os` is a
       *  workers.dev or localhost origin. Set in code, never in Doppler: the per-PR preview's config
       *  (scripts/preview-config.ts `previewWranglerConfig`) and local dev's
       *  (scripts/generate-wrangler-config.ts), as `APP_CONFIG_LOGIN__TEST_LINK__EMAIL_DOMAIN`. */
      testLink: z
        .object({
          emailDomain: dnsName.default(TEST_LINK_EMAIL_DOMAIN),
          /** WHO MAY REDEEM A LINK (test-link.ts): before a link signs anyone in, the browser signs
           *  in at `issuer` — another iterate deployment, prd for a preview — through an OAuth grant
           *  that can only read who they are (the issuer's `/oauth2/userinfo` resource), and only an
           *  address `emails` names redeems it. Required wherever the origin is not localhost
           *  (`parseAppConfig`): a link in a public PR body is then no credential. The preview's
           *  config sets both (scripts/preview-config.ts), as
           *  `APP_CONFIG_LOGIN__TEST_LINK__ADMINS__ISSUER` and `…__ADMINS__EMAILS`. */
          admins: z
            .object({
              issuer: httpOrigin,
              emails: emailPatterns("lists no pattern, so no link could ever be redeemed"),
            })
            .optional(),
        })
        .optional(),
    })
    .prefault({}),
  /** THE PLATFORM ADMINS: exact email addresses, never a pattern — `["jonas@iterate.com"]`, or the
   *  var `APP_CONFIG_ADMINS='["jonas@iterate.com"]'`. A person listed here may be granted the
   *  `admin` scope at consent (every project and person, 12 hours) and may view an app as someone
   *  else (consent.ts); every admission of such a grant reads the list again, so removing an
   *  address ends its admin grants and impersonations at their next request (oauth.ts). Unset ⇒
   *  nobody. The operator bearer is not a person and needs no entry. */
  admins: z
    .array(
      z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^[^@\s*]+@[^@\s*]+$/, "expected exact email addresses, no `*`"),
    )
    .default([]),
  /** THE PLATFORM'S OWN APPS at third parties, which a project connects through instead of bringing
   *  its own (`client: { platform: "<name>" }`, secret-oauth.ts). Each block optional: unset, no
   *  project can connect through the platform's app there. */
  integrations: z
    .object({
      /** iterate's Slack app (integrations/slack/): the OAuth client, the key Slack signs webhooks
       *  with, the bot scopes asked for, and where Slack answers — `slackOrigin`, another origin only
       *  for a fake (a preview's, scripts/preview-config.ts). The keys are the legacy platform's, so
       *  its Doppler JSON is reused as it stands. */
      slack: z
        .object({
          oauthClientId: z.string({ error: REQUIRED }).trim().min(1, REQUIRED),
          oauthClientSecret: redacted(z.string({ error: REQUIRED }).trim().min(1, REQUIRED)),
          webhookSigningSecret: redacted(z.string({ error: REQUIRED }).trim().min(1, REQUIRED)),
          scopes: z.array(z.string().trim().min(1)).default([...DEFAULT_SLACK_BOT_SCOPES]),
          slackOrigin: httpOrigin.default("https://slack.com"),
        })
        .optional(),
      /** iterate's Google OAuth client (integrations/google/): the client and the scopes asked for.
       *  `googleOrigin` is unset for Google itself; set, ONE origin serves every Google path — a
       *  fake's (a preview's, scripts/preview-google-app.ts). The legacy platform's keys. */
      google: z
        .object({
          oauthClientId: z.string({ error: REQUIRED }).trim().min(1, REQUIRED),
          oauthClientSecret: redacted(z.string({ error: REQUIRED }).trim().min(1, REQUIRED)),
          scopes: z.array(z.string().trim().min(1)).default([...DEFAULT_GOOGLE_SCOPES]),
          googleOrigin: httpOrigin.optional(),
        })
        .optional(),
      /** iterate's Cloudflare OAuth client (identity.ts signs in with it; integrations/cloudflare.ts
       *  connects with it). `cloudflareOrigin` is unset for Cloudflare itself (dash.cloudflare.com
       *  issues, api.cloudflare.com answers); set, a fake's origin serves both, its issuer at
       *  `<origin>/cloudflare` (a preview's, scripts/preview-cloudflare-app.ts). */
      cloudflare: z
        .object({
          oauthClientId: z.string({ error: REQUIRED }).trim().min(1, REQUIRED),
          oauthClientSecret: redacted(z.string({ error: REQUIRED }).trim().min(1, REQUIRED)),
          scopes: z.array(z.string().trim().min(1)).default(DEFAULT_CLOUDFLARE_SCOPES),
          cloudflareOrigin: httpOrigin.optional(),
        })
        .optional(),
      /** iterate's GitHub App (integrations/github/): its id and URL slug (public), the OAuth client
       *  that proves a human can see an installation, the private key (PEM, PKCS#8 or GitHub's
       *  PKCS#1) that signs App JWTs and the key GitHub signs webhooks with. `githubOrigin` is
       *  `https://github.com` (its API `https://api.github.com`); another origin serves both — a
       *  fake's. The legacy platform's keys. */
      github: z
        .object({
          appId: z.string({ error: REQUIRED }).trim().min(1, REQUIRED),
          appSlug: z.string({ error: REQUIRED }).trim().min(1, REQUIRED),
          oauthClientId: z.string({ error: REQUIRED }).trim().min(1, REQUIRED),
          oauthClientSecret: redacted(z.string({ error: REQUIRED }).trim().min(1, REQUIRED)),
          privateKey: redacted(z.string({ error: REQUIRED }).trim().min(1, REQUIRED)),
          webhookSecret: redacted(z.string({ error: REQUIRED }).trim().min(1, REQUIRED)),
          githubOrigin: httpOrigin.default("https://github.com"),
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
      /** THE OPERATOR'S BEARER, the deployment's machine credential — `authenticate({ type:
       *  "admin-secret" })` on `/api` (every project, `as` a user without a login) or a bearer there,
       *  never at `/mcp` (oauth.ts `validateToken`): the e2e harness, the deployed specs, deploy
       *  gates, load scripts (docs/credentials.md). Blank ⇒ no operator access (a self-host needs
       *  none: a personal access token covers scripting). */
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

/** Parse the configuration out of `env` (a worker env, or any record — only `APP_CONFIG` and the
 *  `APP_CONFIG_*` keys are read; a blank one is unset). Pure; every test parses through it. A
 *  malformed field throws naming itself. */
export function parseAppConfig(env: object, deployId = "unversioned"): AppConfig {
  const parsed = parseAppConfigVars(env, AppConfig);
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
  // A second guard behind "set in code": even a Doppler value cannot turn test links on at a
  // deployment on its own domain (prd, os.iterate.com) — only on a preview's workers.dev origin or
  // a laptop's.
  if (login.testLink && !isTestLinkOrigin(urls.os))
    throw new Error(
      `${fieldNameOf(["login", "testLink"])}: only for a preview, local dev or a test — urls.os must be a workers.dev, localhost or .test origin, not ${JSON.stringify(urls.os)}`,
    );
  // Off a laptop (or a `.test` origin, never public), a link alone signs nobody in: its redeemer proves at another issuer that they
  // are one of `admins.emails` (test-link.ts). A preview's origin is public, and so is its PR body.
  if (login.testLink && !login.testLink.admins && !isLocalOrTestOrigin(urls.os))
    throw new Error(
      `${fieldNameOf(["login", "testLink", "admins"])}: required off localhost — a preview's links are public, so who redeems one must prove who they are at another issuer`,
    );
  if (login.testLink?.admins && new URL(urls.os).protocol !== "https:")
    throw new Error(
      `${fieldNameOf(["login", "testLink", "admins"])}: only on an https urls.os — the issuer reads this deployment's client metadata document there`,
    );
  // A provider's sign-in without its client is off, loudly: the rest of the deployment still runs.
  const signIn = { ...login };
  for (const provider of ["google", "cloudflare", "github"] as const)
    if (signIn[provider] && !parsed.integrations[provider]) {
      console.warn(
        `${fieldNameOf(["login", provider])}: off — it signs in with integrations.${provider}'s client, which is unset`,
      );
      signIn[provider] = undefined;
    }
  if (
    !signIn.password.exposeSecret() &&
    !signIn.emailCode &&
    !signIn.google &&
    !signIn.cloudflare &&
    !signIn.github
  )
    throw new Error(
      `${fieldNameOf(["login"])}: no sign-in mechanism — set login.password, login.emailCode, or login.google, login.cloudflare or login.github with its integrations client`,
    );
  return {
    ...parsed,
    login: signIn,
    urls: { ...urls, ingressRouting },
    deployId,
  };
}

/** An origin test links may be honoured on (`login.testLink`): an https workers.dev one (a per-PR
 *  preview's), localhost's, or one under `.test` (RFC 2606: never a public name — the workers
 *  suite's). A blank `urls.os` is none of them: it must be named. */
function isTestLinkOrigin(origin: string) {
  if (!origin) return false;
  const { protocol, hostname } = new URL(origin);
  return (
    (protocol === "https:" && hostname.endsWith(".workers.dev")) || isLocalOrTestOrigin(origin)
  );
}

/** A laptop's origin (localhost's or 127.0.0.1's) or one under `.test` (RFC 2606: never a public
 *  name — the workers suite's). */
function isLocalOrTestOrigin(origin: string) {
  const { hostname } = new URL(origin);
  return ["localhost", "127.0.0.1"].includes(hostname) || hostname.endsWith(".test");
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

/** THE SESSION-SIGNING SECRET (caller.ts `signClaims`/`verifyClaims`: the login flow's cookie, a
 *  signed file URL): `secrets.key` under its own label, SHA-256, hex — so the one key a deployment
 *  holds serves two algorithms without being reused raw (secret-at-rest.ts hashes the key under the
 *  other). Rotating the key signs every session out; a mid-rotation `previousKey` opens no session.
 *  Async (WebCrypto), computed once per config object. */
export function sessionSigningSecretOf(config: AppConfig): Promise<string> {
  let secret = sessionSigningSecretByConfig.get(config);
  if (!secret) {
    secret = sha256Hex(`iterate-session-signing:${config.secrets.key.exposeSecret()}`);
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
 *  `/mcp`). The edge stamps every caller with the origin
 *  (`Caller.platformOrigin`); a context persists what its callers said, for the calls that carry
 *  none (a loaded worker's, an alarm's). */
export type PlatformAddresses = {
  platformOrigin: string;
  api: string;
  mcp: string;
  /** the third resource: who the bearer is, and nothing else (api.ts `userinfoResponse`) */
  userinfo: string;
};
/** The userinfo resource's path on the platform origin (`PlatformAddresses.userinfo`). */
export const USERINFO_PATH = "/oauth2/userinfo";

export function platformAddressesOf(env: AppConfigEnv, request: Request): PlatformAddresses {
  const config = appConfigOf(env);
  const platformOrigin = config.urls.os || new URL(request.url).origin;
  return {
    platformOrigin,
    api: `${platformOrigin}/api`,
    mcp: config.urls.mcp ? `${config.urls.mcp}/` : `${platformOrigin}/mcp`,
    userinfo: `${platformOrigin}${USERINFO_PATH}`,
  };
}

/** The project `url` is a host of by the deployment's STATIC rules: under the ingress routing
 *  (iterate/project-ingress: subdomains — a host under the wildcard; paths — `/projects/<project>[/<routingSlug>]` on
 *  the platform origin), or the project wildcard (an owned zone's apex and first-level names). A
 *  hostname a project added itself is the control plane's (control-plane/edge.ts `projectHostOf`). The platform and MCP origins are the
 *  platform's own even when their zone also has a project wildcard. What worker.ts admits a project
 *  host with, and what consent.ts binds a project's CIMD client to. */
export function projectHostOf(
  config: AppConfig,
  url: URL,
  platformOrigin: string,
): ProjectAddress | null {
  // The platform and MCP origins first: `os.<domain>` under a `*.<domain>` project wildcard is the
  // platform's, never project `os`. Under paths the platform origin carries `/projects/…` too.
  if (url.origin === config.urls.mcp) return null;
  if (url.origin === platformOrigin && config.urls.ingressRouting?.type !== "paths") return null;
  const routed = projectAddressOf(config.urls.ingressRouting, url, platformOrigin);
  if (routed) return routed;
  if (url.origin === platformOrigin) return null;
  const wildcard = projectWildcardHostOf(url.hostname, config.urls.projectWildcard);
  return wildcard && { ...wildcard, basePath: "" };
}
