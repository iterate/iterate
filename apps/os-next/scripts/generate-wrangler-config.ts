import { readFileSync } from "node:fs";
import JSON5 from "json5";
import { osNextEnvs } from "../../../envs.ts";
import {
  OBSERVABILITY,
  writeGeneratedWranglerConfig,
} from "../../../scripts/lib/wrangler-config.ts";

/** Runtime bindings stay with the app; deployed names and IDs come from envs.ts. */
export function writeWranglerConfig() {
  const template = JSON5.parse(
    readFileSync(new URL("../wrangler.base.jsonc", import.meta.url), "utf8"),
  );
  const config = {
    ...template,
    routes: [],
    vars: {
      ...template.vars,
      APP_CONFIG_PLATFORM_ORIGIN: "http://localhost:8788",
      APP_CONFIG_MCP_ORIGIN: "",
      APP_CONFIG_PROJECT_HOSTNAME_BASE: "localhost",
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
            { pattern: `${new URL(env.baseUrl).hostname}/*`, zone_name: "iterate2.com" },
            { pattern: `${new URL(env.mcpBaseUrl).hostname}/*`, zone_name: "iterate2.com" },
            ...(env.projectHostnameBase
              ? [{ pattern: `*.${env.projectHostnameBase}/*`, zone_name: env.projectHostnameBase }]
              : []),
            // A custom hostname is a project's apex: its zone is the hostname's registrable domain.
            ...Object.keys(env.projectCustomHostnames || {}).map((hostname) => ({
              pattern: `${hostname}/*`,
              zone_name: hostname.split(".").slice(-2).join("."),
            })),
          ].filter((route) => !route.pattern.includes(".workers.dev/")),
          assets: template.assets,
          durable_objects: template.durable_objects,
          exports: template.exports,
          worker_loaders: template.worker_loaders,
          ai: template.ai,
          browser: template.browser,
          send_email: template.send_email,
          version_metadata: template.version_metadata,
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
          vars: {
            APP_CONFIG_ENVIRONMENT_NAME: name,
            APP_CONFIG_PLATFORM_ORIGIN: env.baseUrl,
            APP_CONFIG_TEST_EMAIL_LOGIN: String(env.testEmailLogin ?? false),
            APP_CONFIG_LOGIN_EMAIL_FROM: env.loginEmailFrom || "",
            APP_CONFIG_MCP_ORIGIN:
              new URL(env.mcpBaseUrl).origin === new URL(env.baseUrl).origin ? "" : env.mcpBaseUrl,
            APP_CONFIG_PROJECT_HOSTNAME_BASE: env.projectHostnameBase,
            APP_CONFIG_PROJECT_CUSTOM_HOSTNAMES: Object.entries(env.projectCustomHostnames || {})
              .map(([hostname, project]) => `${hostname}=${project}`)
              .join(","),
            APP_CONFIG_ARTIFACTS_ACCOUNT_ID: env.cloudflareAccountId,
            APP_CONFIG_ARTIFACTS_NAMESPACE: env.artifactsNamespace,
          },
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
/** The gitignored config `wrangler preview` reads (scripts/preview.ts). */
export const PREVIEW_CONFIG_NAME = "wrangler.preview.jsonc";

/** THE BASELINE every per-PR preview branches from: a Worker Preview is a branch of an existing
 *  worker (cloudflare-os `staging-config.ts`: "one must exist before a preview can be created"), and
 *  nothing reads the baseline's own data. */
export const PREVIEW_BASELINE = osNextEnvs.preview_2!;

/** The workers.dev host a preview's URL hangs under: the baseline's hostname minus its worker name
 *  (`os-next-preview-2.iterate-dev-preview.workers.dev` → `iterate-dev-preview.workers.dev`). */
function previewWorkersDevHost(): string {
  const host = new URL(PREVIEW_BASELINE.baseUrl).hostname;
  const prefix = `${PREVIEW_BASELINE.workerName}.`;
  if (!host.startsWith(prefix))
    throw new Error(`baseline ${host} is not on a workers.dev subdomain`);
  return host.slice(prefix.length);
}

/** `https://<name>-<worker>.<subdomain>.workers.dev` — Cloudflare derives it from the preview's slug
 *  and the worker name, so every URL the config needs is known before anything deploys. */
export const previewUrl = (previewName: string): string =>
  `https://${previewName}-${PREVIEW_BASELINE.workerName}.${previewWorkersDevHost()}`;

/** Every preview-owned resource is `<worker>-<preview>-<binding>`, the name wrangler's preview
 *  auto-provisioning gives the KV namespaces and the R2 bucket; the D1 database and the Artifacts
 *  namespace follow it by hand. */
export const previewResourceName = (previewName: string, binding: string): string =>
  `${PREVIEW_BASELINE.workerName}-${previewName}-${binding}`;

/** wrangler.preview.jsonc — what `wrangler preview` reads. The top level names the baseline (which
 *  worker, which account, the entry, the assets) and declares the eight Durable Object classes as a
 *  legacy `migrations` entry: the pkg.pr.new wrangler build that provisions per-preview KV and R2
 *  predates `exports`, and a preview deployment provisions its own namespaces from that entry. The
 *  `previews` block is the ONE preview's bindings (cloudflare-os `applyBackend`): a preview inherits
 *  nothing from the top level, so every binding and var the worker reads is here. KV and R2 are
 *  binding-only — how wrangler is told to auto-provision a fresh one per preview; D1 is not
 *  auto-provisioned, so scripts/preview.ts creates it and passes the id. Vars: the two the parser
 *  requires (src/app-config.ts), the test sign-in code, and the Artifacts remote; everything else
 *  defaults blank — no MCP origin, no project hosts, no email. */
export function writePreviewWranglerConfig(input: { previewName: string; d1DatabaseId: string }) {
  const template = JSON5.parse(
    readFileSync(new URL("../wrangler.base.jsonc", import.meta.url), "utf8"),
  );
  const baseline = PREVIEW_BASELINE;
  const artifactsNamespace = previewResourceName(input.previewName, "repos");
  const config = {
    name: baseline.workerName,
    account_id: baseline.cloudflareAccountId,
    main: template.main,
    compatibility_date: template.compatibility_date,
    compatibility_flags: template.compatibility_flags,
    workers_dev: true,
    preview_urls: true,
    assets: template.assets,
    migrations: [{ tag: "v1", new_sqlite_classes: Object.keys(template.exports) }],
    previews: {
      observability: OBSERVABILITY,
      limits: template.limits,
      durable_objects: template.durable_objects,
      worker_loaders: template.worker_loaders,
      ai: template.ai,
      browser: template.browser,
      send_email: template.send_email,
      version_metadata: template.version_metadata,
      kv_namespaces: [{ binding: "OAUTH_KV" }, { binding: "ITX_KV" }],
      r2_buckets: [{ binding: "FILES" }],
      d1_databases: [
        {
          binding: "DB",
          database_name: previewResourceName(input.previewName, "db"),
          database_id: input.d1DatabaseId,
        },
      ],
      artifacts: [{ binding: "ARTIFACTS", namespace: artifactsNamespace }],
      vars: {
        APP_CONFIG_ENVIRONMENT_NAME: input.previewName,
        APP_CONFIG_PLATFORM_ORIGIN: previewUrl(input.previewName),
        APP_CONFIG_TEST_EMAIL_LOGIN: "true",
        APP_CONFIG_ARTIFACTS_ACCOUNT_ID: baseline.cloudflareAccountId,
        APP_CONFIG_ARTIFACTS_NAMESPACE: artifactsNamespace,
      },
    },
  };
  return writeGeneratedWranglerConfig({
    configUrl: new URL(`../${PREVIEW_CONFIG_NAME}`, import.meta.url),
    appLabel: "apps/os-next (one per-PR Worker Preview; scripts/preview.ts)",
    config,
  });
}

if (process.argv[1]?.endsWith("generate-wrangler-config.ts")) console.log(writeWranglerConfig());
