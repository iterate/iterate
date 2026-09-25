import { readFileSync } from "node:fs";
import JSON5 from "json5";
import {
  osEnvs,
  PREVIEW_AND_DEV_ACCOUNT_ID,
  previewDeployment,
  type OsEnv,
  type OsPreviewEnv,
} from "../../../envs.ts";
import { OBSERVABILITY, registrableDomainOf } from "../../../scripts/lib/wrangler-config.ts";
import { TEST_LINK_EMAIL_DOMAIN } from "../src/test-link.ts";

/** The half of `APP_CONFIG` (src/app-config.ts) a deployment gets from envs.ts — its `urls`, the
 *  zones of its projects' custom hostnames (`customHostnames`), its `admins`, its PostHog key and a
 *  per-commit deployment's test links — as the override vars the parser merges on top of the
 *  Doppler blob: `APP_CONFIG_URLS__<KEY>`. An object travels as a JSON STRING — the parser reads
 *  string vars only. A blank var is unset. */
function configVars(env: OsPreviewEnv) {
  const vars: Record<string, string> = { APP_CONFIG_URLS__OS: env.baseUrl };
  if (new URL(env.mcpBaseUrl).origin !== new URL(env.baseUrl).origin)
    vars.APP_CONFIG_URLS__MCP = new URL(env.mcpBaseUrl).origin;
  if (env.dashBaseUrl) vars.APP_CONFIG_URLS__DASH = env.dashBaseUrl;
  // THE ONE-CLICK SIGN-IN (src/test-link.ts) the PR body links, and the one admin the admin app's
  // specs sign in as (specs/admin). A deployment that signs anyone in by password or test link
  // opens nothing more by making them an admin.
  const admins = [...(env.admins || []), ...(env.testLinks ? [PREVIEW_ADMIN_EMAIL] : [])];
  if (env.testLinks) {
    vars.APP_CONFIG_LOGIN__TEST_LINK__EMAIL_DOMAIN = TEST_LINK_EMAIL_DOMAIN;
    vars.APP_CONFIG_LOGIN__TEST_LINK__ADMINS__ISSUER = env.testLinks.admins.issuer;
    vars.APP_CONFIG_LOGIN__TEST_LINK__ADMINS__EMAILS = env.testLinks.admins.emails.join(",");
  }
  if (admins.length) vars.APP_CONFIG_ADMINS = JSON.stringify(admins);
  if (env.posthogProjectKey) vars.APP_CONFIG_POSTHOG_PROJECT_KEY = env.posthogProjectKey;
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
function ownZonesOf(env: OsPreviewEnv) {
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
export function routedHostnames(env: OsPreviewEnv) {
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

/** A per-commit deployment's one admin (`APP_CONFIG_ADMINS`; specs/admin signs in as them). */
const PREVIEW_ADMIN_EMAIL = `admin@${TEST_LINK_EMAIL_DOMAIN}`;

/** wrangler.base.jsonc, the template every deployment's config derives from. */
export function readWranglerBase() {
  return JSON5.parse(readFileSync(new URL("../wrangler.base.jsonc", import.meta.url), "utf8"));
}

/** Runtime bindings stay with the app; deployed names and IDs come from envs.ts. This is local dev
 *  (projects under `<project>.localhost`, the secrets as plain dev vars — scripts/dev.ts) on the
 *  dev/preview account; `deploymentWranglerConfig` is what a deployment puts on top. */
function localWranglerConfig() {
  return {
    ...readWranglerBase(),
    // The account a LOCAL worker (`pnpm dev`, the local e2e run) reaches Cloudflare on: wrangler's
    // local runtime has no simulator for Artifacts, AI or Browser and proxies those three bindings
    // to the real products on this account under the developer's `wrangler login` — so a local
    // run's repos land in the dev/preview account's `os-dev-repos` (wrangler.base.jsonc),
    // never in a deployment's namespace.
    account_id: PREVIEW_AND_DEV_ACCOUNT_ID,
    routes: [],
  };
}

/** One deployment's worker: its name, account, routes, vars and resources over the base's
 *  bindings. An envs.ts deployment names its resources by id. A per-commit deployment
 *  (`previewDeployment`) has no ids: its KV is binding-only, which wrangler provisions as
 *  `<worker>-oauth-kv` and `<worker>-itx-kv` on the first deploy, and its D1 is named without an id,
 *  which wrangler finds by name once scripts/deploy.ts has created and migrated it. */
function deploymentWranglerConfig(env: OsEnv | OsPreviewEnv) {
  const {
    d1_databases: [localDatabase],
  } = readWranglerBase();
  const resources = "resources" in env ? env.resources : undefined;
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
    artifacts: [{ binding: "ARTIFACTS", namespace: env.artifactsNamespace }],
    r2_buckets: [{ binding: "FILES", bucket_name: `${env.resourceNamePrefix}-files` }],
    d1_databases: [
      {
        binding: localDatabase.binding,
        migrations_dir: localDatabase.migrations_dir,
        database_name: `${env.resourceNamePrefix}-db`,
        ...(resources && { database_id: resources.dbId }),
      },
    ],
    kv_namespaces: resources
      ? [
          { binding: "OAUTH_KV", id: resources.oauthKvId },
          { binding: "ITX_KV", id: resources.itxKvId },
        ]
      : [{ binding: "OAUTH_KV" }, { binding: "ITX_KV" }],
    vars: configVars(env),
  };
}

/** The Vite plugin builds one flattened environment at a time: `name` is an envs.ts deployment, a
 *  per-commit deployment (`previewDeployment`, `pr3144-a1b2c3d`) or "self-host"; none is a local
 *  build — `localDev` for `vite dev` (plain dev secrets as vars), else the local build the e2e
 *  suite runs, on `port`. */
export function viteWranglerConfig(
  name: string | undefined,
  options: { localDev: boolean; port: string },
) {
  if (name === "self-host") return selfHostWranglerConfig();
  const local = localWranglerConfig();
  if (!name)
    return {
      ...local,
      name: options.localDev ? local.name : "os-local-build",
      vars: {
        APP_CONFIG_URLS__OS: `http://localhost:${options.port}`,
        APP_CONFIG_URLS__INGRESS_ROUTING: JSON.stringify({
          type: "subdomains",
          hostname: "localhost",
        }),
        ...(options.localDev && {
          // one-click sign-in links (src/test-link.ts) — the specs' test-link.spec.ts mints one
          APP_CONFIG_LOGIN__TEST_LINK__EMAIL_DOMAIN: TEST_LINK_EMAIL_DOMAIN,
          APP_CONFIG: JSON.stringify({
            login: { password: "dev", emailCode: { from: "iterate <login@localhost>" } },
            // `pnpm getin`'s person, so the admin app and "view as" work locally, and the admin
            // the specs sign in as (specs/admin, as on a per-commit deployment: PREVIEW_ADMIN_EMAIL)
            admins: [`test@${TEST_LINK_EMAIL_DOMAIN}`, PREVIEW_ADMIN_EMAIL],
            secrets: { adminBearer: "dev-admin-api-secret" },
          }),
          APP_CONFIG_SECRETS__KEY: "dev-secrets-key",
        }),
      },
    };
  const deployment = osEnvs[name] || previewDeployment(name)?.os;
  if (!deployment) throw new Error(`apps/os: unknown env ${JSON.stringify(name)}`);
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
  return {
    ...rest,
    name: "iterate",
    workers_dev: true,
    artifacts: [{ binding: "ARTIFACTS", namespace: "iterate-repos" }],
    r2_buckets: r2_buckets.map(({ binding }: { binding: string }) => ({
      binding,
      bucket_name: "iterate-files",
    })),
    kv_namespaces: kv_namespaces.map(({ binding }: { binding: string }) => ({ binding })),
    d1_databases: [
      {
        binding: localDatabase.binding,
        database_name: "iterate-db",
        migrations_dir: localDatabase.migrations_dir,
      },
    ],
    vars: {
      APP_CONFIG_URLS__INGRESS_ROUTING: JSON.stringify({ type: "paths" }),
      ...(osEnvs.prd!.dashBaseUrl && { APP_CONFIG_URLS__DASH: osEnvs.prd!.dashBaseUrl }),
    },
  };
}
