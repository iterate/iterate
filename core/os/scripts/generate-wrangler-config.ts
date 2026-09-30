import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COMPATIBILITY_DATE } from "iterate/compatibility-date";
import JSON5 from "json5";
import { PROJECT_CONTEXT_BIRTH_EVENTS } from "../src/project/context-birth-events.ts";
import { TEST_EMAIL_DOMAIN } from "../src/test-email-domain.ts";
import { OsDeployableEnv, osResourceNames, type OsEnv } from "./os-env.ts";
import { PREVIEW_CLOUDFLARE_APP } from "./preview-cloudflare-app.ts";
import { PREVIEW_GOOGLE_APP } from "./preview-google-app.ts";
import { PREVIEW_SLACK_APP } from "./preview-slack-app.ts";
import { PREVIEW_X_APP } from "./preview-x-app.ts";
import { OBSERVABILITY, registrableDomainOf } from "./wrangler-config.ts";

/** The half of `APP_CONFIG` (src/app-config.ts) a deployment gets from envs.ts — its `urls`, the
 *  zones of its projects' custom hostnames (`customHostnames`), its `admins` and where they sign in,
 *  its PostHog key and a per-commit deployment's test people and fakes — as the override vars the
 *  parser merges on top of the Doppler blob: `APP_CONFIG_URLS__<KEY>`. An object travels as a JSON STRING — the parser reads
 *  string vars only. A blank var is unset. */
function configVars(env: OsEnv) {
  const vars: Record<string, string> = { APP_CONFIG_URLS__OS: env.baseUrl };
  if (new URL(env.mcpBaseUrl).origin !== new URL(env.baseUrl).origin)
    vars.APP_CONFIG_URLS__MCP = new URL(env.mcpBaseUrl).origin;
  if (env.dashBaseUrl) vars.APP_CONFIG_URLS__DASH = env.dashBaseUrl;
  if (env.admins?.length) vars.APP_CONFIG_ADMINS = JSON.stringify(env.admins);
  if (env.adminIssuer) vars.APP_CONFIG_LOGIN__ADMIN_ISSUER = env.adminIssuer;
  if (env.testEmailDomain) vars.APP_CONFIG_LOGIN__TEST_EMAIL_DOMAIN = env.testEmailDomain;
  if (env.posthogProjectKey) vars.APP_CONFIG_POSTHOG_PROJECT_KEY = env.posthogProjectKey;
  vars.APP_CONFIG_CONTEXT_BIRTH_EVENTS = JSON.stringify(PROJECT_CONTEXT_BIRTH_EVENTS);
  // THE PET SHOP'S FAKES as iterate's Slack app and Google and Cloudflare clients, and sign-in with
  // Google, Cloudflare and GitHub through them, each keeping its token as the person's connection
  // (a fake admits addresses under `testEmailDomain` alone). The GitHub App carries a key, so
  // scripts/os/deploy.ts ships it as a secret.
  if (env.petshopOrigin) {
    vars.APP_CONFIG_INTEGRATIONS__SLACK = JSON.stringify({
      ...PREVIEW_SLACK_APP,
      slackOrigin: env.petshopOrigin,
    });
    vars.APP_CONFIG_INTEGRATIONS__GOOGLE = JSON.stringify({
      ...PREVIEW_GOOGLE_APP,
      googleOrigin: env.petshopOrigin,
    });
    vars.APP_CONFIG_INTEGRATIONS__X = JSON.stringify({
      ...PREVIEW_X_APP,
      xOrigin: env.petshopOrigin,
    });
    vars.APP_CONFIG_INTEGRATIONS__CLOUDFLARE = JSON.stringify({
      ...PREVIEW_CLOUDFLARE_APP,
      cloudflareOrigin: env.petshopOrigin,
    });
    vars.APP_CONFIG_LOGIN__GOOGLE = "{}";
    vars.APP_CONFIG_LOGIN__CLOUDFLARE = JSON.stringify({
      scopes: ["openid", "user-details.read", "offline_access"],
    });
    vars.APP_CONFIG_LOGIN__GITHUB = "{}";
  }
  if (env.ingressRouting)
    vars.APP_CONFIG_URLS__INGRESS_ROUTING = JSON.stringify(env.ingressRouting);
  if (env.projectWildcard)
    vars.APP_CONFIG_URLS__PROJECT_WILDCARD = JSON.stringify(env.projectWildcard);
  // a project's own custom hostnames go on the first SaaS zone; the token is Doppler's
  // (APP_CONFIG_CLOUDFLARE_API_TOKEN)
  if (env.cloudflareForSaas)
    vars.APP_CONFIG_CUSTOM_HOSTNAMES = JSON.stringify({
      ...env.cloudflareForSaas,
      reservedZones: [...ownZonesOf(env)].sort(),
    });
  return vars;
}

/** The zones a deployment owns: those of its own hostnames, its project wildcard, and its SaaS
 *  project-host zones. No project may add a custom hostname equal to or under one of these
 *  (`customHostnames.reservedZones`). */
function ownZonesOf(env: OsEnv) {
  return new Set([
    registrableDomainOf(new URL(env.baseUrl).hostname),
    registrableDomainOf(new URL(env.mcpBaseUrl).hostname),
    ...(env.ingressRouting?.type === "subdomains" ? [env.ingressRouting.hostname] : []),
    ...(env.projectWildcard ? [env.projectWildcard.hostname] : []),
    ...(env.cloudflareForSaas ? [env.cloudflareForSaas.zone] : []),
  ]);
}

/** The hostnames a deployment's Worker routes, each with the zone its route binds to — and so the
 *  hostnames ensure-resources gives a proxied DNS record: its origins, the ingress wildcard, and the
 *  project wildcard's apex and wildcard. A project's own custom hostname is a Cloudflare for SaaS
 *  custom hostname, reached through the SaaS zone's one `*\/*` route (wranglerConfig). A workers.dev
 *  host is served by `workers_dev` itself. */
export function routedHostnames(env: OsEnv) {
  const ownHost = (hostname: string) => ({ hostname, zone: registrableDomainOf(hostname) });
  const wildcard = (hostname: string) => ({ hostname: `*.${hostname}`, zone: hostname });
  return [
    ownHost(new URL(env.baseUrl).hostname),
    ownHost(new URL(env.mcpBaseUrl).hostname),
    ...(env.ingressRouting?.type === "subdomains" ? [wildcard(env.ingressRouting.hostname)] : []),
    ...(env.projectWildcard
      ? [ownHost(env.projectWildcard.hostname), wildcard(env.projectWildcard.hostname)]
      : []),
  ].filter(({ hostname }) => !hostname.endsWith(".workers.dev"));
}

/** wrangler.base.jsonc, the template every deployment's config derives from. */
export function readWranglerBase() {
  const base = JSON5.parse(
    readFileSync(join(import.meta.dirname, "../wrangler.base.jsonc"), "utf8"),
  );
  return { ...base, compatibility_date: COMPATIBILITY_DATE };
}

/** Runtime bindings stay with the app; deployed names and IDs come from the deployment. This is local dev
 *  (projects under `<project>.localhost`, the secrets as plain dev vars — scripts/dev.ts);
 *  `deploymentWranglerConfig` is what a deployment puts on top. */
function localWranglerConfig() {
  return {
    ...readWranglerBase(),
    // No `account_id`: wrangler's local runtime has no simulator for Artifacts, AI or Browser and
    // proxies those three bindings to the real products on the account wrangler picks,
    // CLOUDFLARE_ACCOUNT_ID or else the `wrangler login`'s. iterate's root `pnpm dev`
    // (scripts/os-dev.ts) sets the dev/preview account, so a local run's repos land in its
    // `os-dev-repos` (wrangler.base.jsonc), never in a deployment's namespace.
    routes: [],
  };
}

/** One deployment's worker: its name, account, routes, vars and resources over the base's
 *  bindings. An envs.ts deployment names its resources by id. A per-commit deployment
 *  (`previewDeployment`) has no ids: its KV is binding-only, which wrangler provisions as
 *  `<worker>-oauth-kv` and `<worker>-itx-kv` on the first deploy, and its D1 is named without an id,
 *  which wrangler finds by name once scripts/os/deploy.ts has created and migrated it. */
function deploymentWranglerConfig(env: OsEnv) {
  const {
    d1_databases: [localDatabase],
  } = readWranglerBase();
  const names = osResourceNames(env.resourceNamePrefix);
  return {
    name: env.workerName,
    account_id: env.cloudflareAccountId,
    workers_dev: true,
    observability: OBSERVABILITY,
    routes: [
      ...routedHostnames(env).map(({ hostname, zone }) => ({
        pattern: `${hostname}/*`,
        zone_name: zone,
      })),
      ...(env.cloudflareForSaas ? [{ pattern: "*/*", zone_name: env.cloudflareForSaas.zone }] : []),
    ],
    artifacts: [{ binding: "ARTIFACTS", namespace: names.repos }],
    r2_buckets: [{ binding: "FILES", bucket_name: names.files }],
    d1_databases: [
      {
        binding: localDatabase.binding,
        migrations_dir: localDatabase.migrations_dir,
        database_name: names.db,
        ...(env.resources && { database_id: env.resources.dbId }),
      },
    ],
    kv_namespaces: [
      { binding: "OAUTH_KV", ...(env.resources && { id: env.resources.oauthKvId }) },
      { binding: "ITX_KV", ...(env.resources && { id: env.resources.itxKvId }) },
    ],
    vars: configVars(env),
  };
}

/** THE DEPLOYMENT A BUILD IS FOR, from the environment its caller set (vite.config.ts):
 *  `CLOUDFLARE_ENV` names it and `OS_DEPLOYMENT` is the deployment itself, as JSON (./build.ts
 *  `viteBuildOs`, which ./deploy.ts and ./preview.ts call with envs.ts `getOsEnv`).
 *  "self-host" and no name (a local build) need nothing more. core/os looks no deployment up by
 *  name: the list of iterate's is envs.ts's, outside core/os. */
export function deploymentFromEnv(env: { CLOUDFLARE_ENV?: string; OS_DEPLOYMENT?: string }) {
  const name = env.CLOUDFLARE_ENV;
  if (!name) return undefined;
  if (name === "self-host") return name;
  if (!env.OS_DEPLOYMENT)
    throw new Error(
      `core/os: CLOUDFLARE_ENV=${name} needs OS_DEPLOYMENT, the deployment as JSON; build with scripts/build.ts viteBuildOs`,
    );
  const deployment = OsDeployableEnv.parse(JSON.parse(env.OS_DEPLOYMENT));
  if (deployment.name !== name)
    throw new Error(
      `core/os: CLOUDFLARE_ENV=${name} but OS_DEPLOYMENT is ${JSON.stringify(deployment.name)}`,
    );
  return deployment;
}

/** The Vite plugin builds one flattened environment at a time: a deployment (prd, main on dev, a
 *  per-commit `pr3144-a1b2c3d`), "self-host", or none for a local build — `localDev` for
 *  `vite dev` (plain dev secrets as vars), else the local build the e2e suite runs, on `port`. */
export function viteWranglerConfig(
  deployment: OsDeployableEnv | "self-host" | undefined,
  options: { localDev: boolean; port: string },
) {
  if (deployment === "self-host") return selfHostWranglerConfig();
  const local = localWranglerConfig();
  if (!deployment)
    return {
      ...local,
      name: options.localDev ? local.name : "os-local-build",
      vars: {
        APP_CONFIG_URLS__OS: `http://localhost:${options.port}`,
        APP_CONFIG_URLS__INGRESS_ROUTING: JSON.stringify({
          type: "subdomains",
          hostname: "localhost",
        }),
        APP_CONFIG_CONTEXT_BIRTH_EVENTS: JSON.stringify(PROJECT_CONTEXT_BIRTH_EVENTS),
        ...(options.localDev && {
          APP_CONFIG: JSON.stringify({
            login: {
              password: "dev",
              emailCode: { from: "iterate <login@localhost>" },
              // its test people's (getin's, the specs'), as a per-commit deployment's: a sign-in
              // link naming one pre-fills an admin's "Sign in as someone else" (consent.ts), and it
              // opens `pnpm getin`'s one-click `/.auth/local-sign-in` (src/local-sign-in.ts)
              testEmailDomain: TEST_EMAIL_DOMAIN,
            },
            // `pnpm getin`'s person, so the admin app and "view as" work locally, and the admin
            // the specs sign in as (test/playwright/admin, as on a per-commit deployment: envs.ts
            // `previewDeployment`)
            admins: [`test@${TEST_EMAIL_DOMAIN}`, `admin@${TEST_EMAIL_DOMAIN}`],
            secrets: { adminBearer: "dev-admin-api-secret" },
          }),
          APP_CONFIG_SECRETS__KEY: "dev-secrets-key",
        }),
      },
    };
  return { ...local, ...deploymentWranglerConfig(deployment) };
}

/** THE SELF-HOST CONFIG (SELF-HOSTING.md): the same worker, the same bindings, for a deployment into
 *  an account that is not ours — no account id, no routes, no resource ids (wrangler provisions the
 *  D1, KV and R2 by name on the first deploy), projects as paths on the one workers.dev origin, the
 *  dash ours. `urls.os` stays unset: the worker takes each request's own origin. Every secret is in
 *  the `APP_CONFIG` blob (login.password) and `APP_CONFIG_SECRETS__KEY`, put at deploy time. */
function selfHostWranglerConfig() {
  const {
    routes: _routes,
    kv_namespaces,
    r2_buckets,
    d1_databases: [localDatabase],
    ...rest
  } = readWranglerBase();
  const names = osResourceNames("iterate");
  return {
    ...rest,
    name: "iterate",
    workers_dev: true,
    artifacts: [{ binding: "ARTIFACTS", namespace: names.repos }],
    r2_buckets: r2_buckets.map(({ binding }: { binding: string }) => ({
      binding,
      bucket_name: names.files,
    })),
    kv_namespaces: kv_namespaces.map(({ binding }: { binding: string }) => ({ binding })),
    d1_databases: [
      {
        binding: localDatabase.binding,
        database_name: names.db,
        migrations_dir: localDatabase.migrations_dir,
      },
    ],
    vars: {
      APP_CONFIG_URLS__INGRESS_ROUTING: JSON.stringify({ type: "paths" }),
      APP_CONFIG_CONTEXT_BIRTH_EVENTS: JSON.stringify(PROJECT_CONTEXT_BIRTH_EVENTS),
      // iterate's own dash (envs.ts `osEnvs.prd.dashBaseUrl`)
      APP_CONFIG_URLS__DASH: "https://dash.iterate.com",
    },
  };
}
