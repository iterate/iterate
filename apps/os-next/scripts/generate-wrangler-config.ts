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
      APP_CONFIG_DASH_ORIGIN: "",
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
            APP_CONFIG_DASH_ORIGIN: env.dashBaseUrl || "",
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

/** THE PARENT of every per-PR preview: a Worker Preview is a branch of an existing worker
 *  (cloudflare-os `staging-config.ts`: "one must exist before a preview can be created"). This is
 *  that worker — os-next-preview on the dev/preview account (envs.ts). Nothing reads its data. */
export const PREVIEW_PARENT = osNextEnvs.preview!;

/** `https://<name>-<worker>.<subdomain>.workers.dev` — Cloudflare derives it from the preview's slug
 *  and the worker name, so every URL the config needs is known before anything deploys. */
export function previewUrl(previewName: string): string {
  const host = new URL(PREVIEW_PARENT.baseUrl).hostname;
  const prefix = `${PREVIEW_PARENT.workerName}.`;
  if (!host.startsWith(prefix))
    throw new Error(`${host} is not the parent worker's workers.dev host`);
  return `https://${previewName}-${host}`;
}

/** Every preview-owned resource is `<worker>-<preview>-<binding>`, the name wrangler's preview
 *  auto-provisioning gives the KV namespaces and the R2 bucket; the D1 database and the Artifacts
 *  namespace follow it by hand. */
export const previewResourceName = (previewName: string, binding: string): string =>
  `${PREVIEW_PARENT.workerName}-${previewName}-${binding}`;

/** A resource list with only its `binding` names kept — how wrangler is told to auto-provision a
 *  fresh one per preview (cloudflare-os `previewResourceBindings`). */
const bindingOnly = (resources: { binding: string }[] | undefined) =>
  (resources || []).map(({ binding }) => ({ binding }));

/** The config `wrangler preview` reads, as a pure function of the template (wrangler.base.jsonc),
 *  the preview's name and its D1 — the shape of cloudflare-os's `buildPreviewConfigs`, unit-tested
 *  in preview.test.ts. The top level names the parent (which worker, which account, the entry, the
 *  assets) and declares the Durable Object classes as a legacy `migrations` entry: the pkg.pr.new
 *  wrangler build that provisions per-preview KV and R2 predates `exports`, and a preview
 *  deployment provisions its own namespaces from that entry. The `previews` block is the ONE
 *  preview's bindings — a preview inherits nothing from the top level, so every binding and var the
 *  worker reads is here: KV and R2 binding-only (auto-provisioned), the D1 scripts/preview.ts
 *  created, the Artifacts namespace by name, and vars: the two the parser requires (src/app-config.ts),
 *  the test sign-in code, and the Artifacts remote; everything else defaults blank — no MCP origin,
 *  no project hosts, no email. */
export function previewWranglerConfig(input: {
  template: Record<string, any>;
  previewName: string;
  d1DatabaseId: string;
}) {
  const { template, previewName } = input;
  const artifactsNamespace = previewResourceName(previewName, "repos");
  return {
    name: PREVIEW_PARENT.workerName,
    account_id: PREVIEW_PARENT.cloudflareAccountId,
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
      kv_namespaces: bindingOnly(template.kv_namespaces),
      r2_buckets: bindingOnly(template.r2_buckets),
      d1_databases: template.d1_databases.map(({ binding }: { binding: string }) => ({
        binding,
        database_name: previewResourceName(previewName, "db"),
        database_id: input.d1DatabaseId,
      })),
      artifacts: template.artifacts.map(({ binding }: { binding: string }) => ({
        binding,
        namespace: artifactsNamespace,
      })),
      vars: {
        APP_CONFIG_ENVIRONMENT_NAME: previewName,
        APP_CONFIG_PLATFORM_ORIGIN: previewUrl(previewName),
        APP_CONFIG_TEST_EMAIL_LOGIN: "true",
        APP_CONFIG_ARTIFACTS_ACCOUNT_ID: PREVIEW_PARENT.cloudflareAccountId,
        APP_CONFIG_ARTIFACTS_NAMESPACE: artifactsNamespace,
      },
    },
  };
}

/** Write wrangler.preview.jsonc for one preview and return its path. */
export function writePreviewWranglerConfig(input: { previewName: string; d1DatabaseId: string }) {
  const template = JSON5.parse(
    readFileSync(new URL("../wrangler.base.jsonc", import.meta.url), "utf8"),
  );
  return writeGeneratedWranglerConfig({
    configUrl: new URL(`../${PREVIEW_CONFIG_NAME}`, import.meta.url),
    appLabel: "apps/os-next (one per-PR Worker Preview; scripts/preview.ts)",
    config: previewWranglerConfig({ template, ...input }),
  });
}

if (process.argv[1]?.endsWith("generate-wrangler-config.ts")) console.log(writeWranglerConfig());
