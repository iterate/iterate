import { readFileSync } from "node:fs";
import JSON5 from "json5";
import { osNextEnvs, PREVIEW_AND_DEV_ACCOUNT_ID, type OsNextEnv } from "../../../envs.ts";
import { registrableDomainOf } from "../../../scripts/lib/start-app.ts";
import {
  OBSERVABILITY,
  writeGeneratedWranglerConfig,
} from "../../../scripts/lib/wrangler-config.ts";

/** The `urls` half of `APP_CONFIG` (src/app-config.ts) a deployment gets from envs.ts, as the
 *  override vars the parser merges on top of the Doppler blob: `APP_CONFIG_URLS__<KEY>`. An object
 *  travels as a JSON STRING — the parser reads string vars only. A blank var is unset. */
function urlVars(env: OsNextEnv): Record<string, string> {
  const vars: Record<string, string> = { APP_CONFIG_URLS__OS: env.baseUrl };
  if (new URL(env.mcpBaseUrl).origin !== new URL(env.baseUrl).origin)
    vars.APP_CONFIG_URLS__MCP = new URL(env.mcpBaseUrl).origin;
  if (env.dashBaseUrl) vars.APP_CONFIG_URLS__DASH = env.dashBaseUrl;
  if (env.ingressRouting)
    vars.APP_CONFIG_URLS__INGRESS_ROUTING = JSON.stringify(env.ingressRouting);
  if (env.temporaryCustomHostnames)
    vars.APP_CONFIG_URLS__TEMPORARY_CUSTOM_HOSTNAMES = JSON.stringify(env.temporaryCustomHostnames);
  return vars;
}

/** The zones a deployment owns: those of its own hostnames and its SaaS project-host zones. A custom
 *  hostname under one of these routes on that zone (and gets a DNS record); any other is a Cloudflare
 *  for SaaS custom hostname (ensure-resources creates it on the first SaaS zone). */
export function ownZonesOf(env: OsNextEnv): Set<string> {
  return new Set([
    registrableDomainOf(new URL(env.baseUrl).hostname),
    registrableDomainOf(new URL(env.mcpBaseUrl).hostname),
    ...(env.ingressRouting?.type === "subdomains" ? [env.ingressRouting.hostname] : []),
    ...(env.cloudflareForSaasProjectHostnameBases || []),
  ]);
}

function template() {
  return JSON5.parse(readFileSync(new URL("../wrangler.base.jsonc", import.meta.url), "utf8"));
}

/** Runtime bindings stay with the app; deployed names and IDs come from envs.ts. The top-level
 *  block is local dev (projects under `<project>.localhost`, the secrets as plain dev vars —
 *  scripts/dev.ts) on the dev/preview account, one `env` block per deployment. */
export function writeWranglerConfig() {
  const base = template();
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
    d1_databases: _d1,
    kv_namespaces: _kv,
    vars: _vars,
    ...bindings
  } = base;
  const config = {
    ...base,
    // The account a LOCAL worker (`pnpm dev`, the local e2e run) reaches Cloudflare on: wrangler's
    // local runtime has no simulator for Artifacts, AI or Browser and proxies those three bindings
    // to the real products on this account under the developer's `wrangler login` — so a local
    // run's repos land in the dev/preview account's `os-next-dev-repos` (wrangler.base.jsonc),
    // never in a deployment's namespace.
    account_id: PREVIEW_AND_DEV_ACCOUNT_ID,
    routes: [],
    vars: {
      APP_CONFIG_URLS__OS: "http://localhost:8788",
      APP_CONFIG_URLS__INGRESS_ROUTING: JSON.stringify({
        type: "subdomains",
        hostname: "localhost",
      }),
    },
    env: Object.fromEntries(
      Object.entries(osNextEnvs).map(([name, env]) => [
        name,
        {
          name: env.workerName,
          account_id: env.cloudflareAccountId,
          workers_dev: true,
          observability: OBSERVABILITY,
          triggers: { crons: ["17 * * * *"] },
          routes: [
            {
              pattern: `${new URL(env.baseUrl).hostname}/*`,
              zone_name: registrableDomainOf(new URL(env.baseUrl).hostname),
            },
            {
              pattern: `${new URL(env.mcpBaseUrl).hostname}/*`,
              zone_name: registrableDomainOf(new URL(env.mcpBaseUrl).hostname),
            },
            ...(env.ingressRouting?.type === "subdomains"
              ? [
                  {
                    pattern: `*.${env.ingressRouting.hostname}/*`,
                    zone_name: env.ingressRouting.hostname,
                  },
                ]
              : []),
            // A custom hostname is a project's apex. One whose zone is this account's (iterate2.com)
            // gets its own route on that zone; one whose zone lives in ANOTHER account is a Cloudflare
            // for SaaS custom hostname on a SaaS zone, reached through that zone's one `*\/*` route.
            ...Object.keys(env.temporaryCustomHostnames || {})
              .filter((hostname) => ownZonesOf(env).has(registrableDomainOf(hostname)))
              .map((hostname) => ({
                pattern: `${hostname}/*`,
                zone_name: registrableDomainOf(hostname),
              })),
            ...(env.cloudflareForSaasProjectHostnameBases || []).map((zone) => ({
              pattern: "*/*",
              zone_name: zone,
            })),
          ].filter((route) => !route.pattern.includes(".workers.dev/")),
          ...bindings,
          artifacts: [{ binding: "ARTIFACTS", namespace: env.artifactsNamespace }],
          r2_buckets: [{ binding: "FILES", bucket_name: `${env.resourceNamePrefix}-files` }],
          d1_databases: [
            {
              binding: "DB",
              database_name: `${env.resourceNamePrefix}-directory`,
              database_id: env.resources.directoryDbId,
            },
          ],
          kv_namespaces: [
            { binding: "OAUTH_KV", id: env.resources.oauthKvId },
            { binding: "ITX_KV", id: env.resources.itxKvId },
          ],
          vars: urlVars(env),
        },
      ]),
    ),
  };
  return writeGeneratedWranglerConfig({
    configUrl: new URL("../wrangler.jsonc", import.meta.url),
    appLabel: "apps/os-next",
    config,
  });
}

/** THE SELF-HOST CONFIG (SELF-HOSTING.md): the same worker, the same bindings, for a deployment into
 *  an account that is not ours — no account id, no routes, no resource ids (wrangler provisions the
 *  D1, KV and R2 by name on the first deploy), projects as paths on the one workers.dev origin, the
 *  dash ours. `urls.os` stays unset: the worker takes each request's own origin. Every secret is in
 *  the `APP_CONFIG` blob (login.password) and `APP_CONFIG_SECRETS__KEY`, put at deploy time. */
export function writeSelfHostWranglerConfig() {
  const base = template();
  const { routes: _routes, d1_databases, kv_namespaces, r2_buckets, ...rest } = base;
  const config = {
    ...rest,
    name: "iterate",
    workers_dev: true,
    artifacts: [{ binding: "ARTIFACTS", namespace: "iterate-repos" }],
    r2_buckets: r2_buckets.map(({ binding }: { binding: string }) => ({
      binding,
      bucket_name: "iterate-files",
    })),
    d1_databases: d1_databases.map(({ binding }: { binding: string }) => ({
      binding,
      database_name: "iterate-directory",
    })),
    kv_namespaces: kv_namespaces.map(({ binding }: { binding: string }) => ({ binding })),
    vars: {
      APP_CONFIG_URLS__INGRESS_ROUTING: JSON.stringify({ type: "paths" }),
      ...(osNextEnvs.prd!.dashBaseUrl && { APP_CONFIG_URLS__DASH: osNextEnvs.prd!.dashBaseUrl }),
    },
  };
  return writeGeneratedWranglerConfig({
    configUrl: new URL("../wrangler.self-host.jsonc", import.meta.url),
    appLabel: "apps/os-next (self-host)",
    extraDocs: "apps/os-next/SELF-HOSTING.md",
    config,
  });
}

if (process.argv[1]?.endsWith("generate-wrangler-config.ts")) {
  console.log(writeWranglerConfig());
  console.log(writeSelfHostWranglerConfig());
}
