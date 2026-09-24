import { readFileSync } from "node:fs";
import JSON5 from "json5";
import { osEnvs, PREVIEW_AND_DEV_ACCOUNT_ID, type OsEnv } from "../../../envs.ts";
import { OBSERVABILITY, registrableDomainOf } from "../../../scripts/lib/wrangler-config.ts";
import { TEST_LINK_EMAIL_DOMAIN } from "../src/test-link.ts";

/** The `urls` half of `APP_CONFIG` (src/app-config.ts) a deployment gets from envs.ts, as the
 *  override vars the parser merges on top of the Doppler blob: `APP_CONFIG_URLS__<KEY>`. An object
 *  travels as a JSON STRING — the parser reads string vars only. A blank var is unset. */
function urlVars(env: OsEnv) {
  const vars: Record<string, string> = { APP_CONFIG_URLS__OS: env.baseUrl };
  if (new URL(env.mcpBaseUrl).origin !== new URL(env.baseUrl).origin)
    vars.APP_CONFIG_URLS__MCP = new URL(env.mcpBaseUrl).origin;
  if (env.dashBaseUrl) vars.APP_CONFIG_URLS__DASH = env.dashBaseUrl;
  if (env.ingressRouting)
    vars.APP_CONFIG_URLS__INGRESS_ROUTING = JSON.stringify(env.ingressRouting);
  if (env.temporaryCustomHostnames)
    vars.APP_CONFIG_URLS__TEMPORARY_CUSTOM_HOSTNAMES = JSON.stringify(env.temporaryCustomHostnames);
  if (env.projectWildcard)
    vars.APP_CONFIG_URLS__PROJECT_WILDCARD = JSON.stringify(env.projectWildcard);
  return vars;
}

/** The zones a deployment owns: those of its own hostnames, project-owned custom apexes, and SaaS
 *  project-host zones. A custom hostname under one of these routes on that zone (and gets a DNS record); any other is a Cloudflare
 *  for SaaS custom hostname (ensure-resources creates it on the first SaaS zone). */
export function ownZonesOf(env: OsEnv) {
  return new Set([
    registrableDomainOf(new URL(env.baseUrl).hostname),
    registrableDomainOf(new URL(env.mcpBaseUrl).hostname),
    ...(env.ingressRouting?.type === "subdomains" ? [env.ingressRouting.hostname] : []),
    ...(env.ownedProjectCustomApexes || []),
    ...(env.projectWildcard ? [env.projectWildcard.hostname] : []),
    ...(env.cloudflareForSaasProjectHostnameBases || []),
  ]);
}

/** The hostnames a deployment's Worker routes, each with the zone its route binds to — and so the
 *  hostnames ensure-resources gives a proxied DNS record. A custom hostname is a project's apex: one
 *  whose zone is this account's (iterate.com) gets its own route on that zone; one whose zone lives
 *  in ANOTHER account is a Cloudflare for SaaS custom hostname on a SaaS zone, reached through that
 *  zone's one `*\/*` route (wranglerConfig) and created by ensure-resources. A workers.dev host is
 *  served by `workers_dev` itself. */
export function routedHostnames(env: OsEnv) {
  const ownHost = (hostname: string) => ({ hostname, zone: registrableDomainOf(hostname) });
  const wildcard = (hostname: string) => ({ hostname: `*.${hostname}`, zone: hostname });
  return [
    ownHost(new URL(env.baseUrl).hostname),
    ownHost(new URL(env.mcpBaseUrl).hostname),
    ...(env.ingressRouting?.type === "subdomains" ? [wildcard(env.ingressRouting.hostname)] : []),
    ...(env.projectWildcard ? [wildcard(env.projectWildcard.hostname)] : []),
    ...Object.keys(env.temporaryCustomHostnames || {})
      .filter((hostname) => ownZonesOf(env).has(registrableDomainOf(hostname)))
      .map(ownHost),
  ].filter(({ hostname }) => !hostname.endsWith(".workers.dev"));
}

/** wrangler.base.jsonc, the template every deployment's and preview's config derives from. */
export function readWranglerBase() {
  return JSON5.parse(readFileSync(new URL("../wrangler.base.jsonc", import.meta.url), "utf8"));
}

/** Runtime bindings stay with the app; deployed names and IDs come from envs.ts. The top-level
 *  block is local dev (projects under `<project>.localhost`, the secrets as plain dev vars —
 *  scripts/dev.ts) on the dev/preview account, one `env` block per deployment. */
function wranglerConfig() {
  const base = readWranglerBase();
  // THE BINDINGS every env block repeats (wrangler does not inherit them): the base minus its
  // inheritable keys and minus what an env block sets for itself (the resource ids, routes, vars).
  const {
    $schema: _schema,
    name: _name,
    main: _main,
    compatibility_date: _compatibilityDate,
    compatibility_flags: _compatibilityFlags,
    observability: _observability,
    workers_dev: _workersDev,
    routes: _routes,
    limits: _limits,
    r2_buckets: _r2,
    artifacts: _artifacts,
    kv_namespaces: _kv,
    ...bindings
  } = base;
  return {
    ...base,
    // The account a LOCAL worker (`pnpm dev`, the local e2e run) reaches Cloudflare on: wrangler's
    // local runtime has no simulator for Artifacts, AI or Browser and proxies those three bindings
    // to the real products on this account under the developer's `wrangler login` — so a local
    // run's repos land in the dev/preview account's `os-dev-repos` (wrangler.base.jsonc),
    // never in a deployment's namespace.
    account_id: PREVIEW_AND_DEV_ACCOUNT_ID,
    routes: [],
    env: Object.fromEntries(
      Object.entries(osEnvs).map(([name, env]) => [
        name,
        {
          name: env.workerName,
          account_id: env.cloudflareAccountId,
          workers_dev: true,
          observability: OBSERVABILITY,
          routes: [
            ...routedHostnames(env).map(({ hostname, zone }) => ({
              pattern: `${hostname}/*`,
              zone_name: zone,
            })),
            ...(env.cloudflareForSaasProjectHostnameBases || []).map((zone) => ({
              pattern: "*/*",
              zone_name: zone,
            })),
          ],
          ...bindings,
          artifacts: [{ binding: "ARTIFACTS", namespace: env.artifactsNamespace }],
          r2_buckets: [{ binding: "FILES", bucket_name: `${env.resourceNamePrefix}-files` }],
          kv_namespaces: [
            { binding: "OAUTH_KV", id: env.resources.oauthKvId },
            { binding: "ITX_KV", id: env.resources.itxKvId },
          ],
          // unset ⇒ undefined, which the JSON config drops: no var, no PostHog on the pages
          vars: { ...urlVars(env), POSTHOG_PROJECT_KEY: env.posthogProjectKey },
        },
      ]),
    ),
  };
}

/** The Vite plugin builds one flattened environment at a time: `name` is an envs.ts deployment or
 *  "self-host"; none is a local build — `localDev` for `vite dev` (plain dev secrets as vars), else
 *  the local build the e2e lane runs, on `port`. */
export function viteWranglerConfig(
  name: string | undefined,
  options: { localDev: boolean; port: string },
) {
  if (name === "self-host") return selfHostWranglerConfig();
  const { env, ...local } = wranglerConfig();
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
            secrets: { adminBearer: "dev-admin-api-secret" },
          }),
          APP_CONFIG_SECRETS__KEY: "dev-secrets-key",
        }),
      },
    };
  const deployment = env[name];
  if (!deployment) throw new Error(`apps/os: unknown env ${JSON.stringify(name)}`);
  return { ...local, ...deployment };
}

/** THE SELF-HOST CONFIG (SELF-HOSTING.md): the same worker, the same bindings, for a deployment into
 *  an account that is not ours — no account id, no routes, no resource ids (wrangler provisions the
 *  KV and R2 by name on the first deploy), projects as paths on the one workers.dev origin, the
 *  dash ours. `urls.os` stays unset: the worker takes each request's own origin. Every secret is in
 *  the `APP_CONFIG` blob (login.password) and `APP_CONFIG_SECRETS__KEY`, put at deploy time. */
function selfHostWranglerConfig() {
  const { routes: _routes, kv_namespaces, r2_buckets, ...rest } = readWranglerBase();
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
    vars: {
      APP_CONFIG_URLS__INGRESS_ROUTING: JSON.stringify({ type: "paths" }),
      ...(osEnvs.prd!.dashBaseUrl && { APP_CONFIG_URLS__DASH: osEnvs.prd!.dashBaseUrl }),
    },
  };
}
