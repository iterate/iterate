import { readFileSync } from "node:fs";
import JSON5 from "json5";
import { projectWorkerEnvs } from "../../../../envs.ts";
import {
  OBSERVABILITY,
  writeGeneratedWranglerConfig,
} from "../../../../scripts/lib/wrangler-config.ts";

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
      Object.entries(projectWorkerEnvs).map(([name, env]) => [
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
            { pattern: `*.${env.projectHostnameBase}/*`, zone_name: env.projectHostnameBase },
          ],
          durable_objects: template.durable_objects,
          exports: template.exports,
          worker_loaders: template.worker_loaders,
          ai: template.ai,
          assets: template.assets,
          version_metadata: template.version_metadata,
          artifacts: [{ binding: "ARTIFACTS", namespace: env.artifactsNamespace }],
          d1_databases: [
            {
              binding: "DB",
              database_name: `${env.workerName}-directory`,
              database_id: env.resources.directoryDbId,
            },
          ],
          kv_namespaces: [
            { binding: "OAUTH_KV", id: env.resources.oauthKvId },
            { binding: "SECRETS_KV", id: env.resources.secretsKvId },
            { binding: "ITX_KV", id: env.resources.itxKvId },
          ],
          vars: {
            APP_CONFIG_ENVIRONMENT_NAME: name,
            APP_CONFIG_PLATFORM_ORIGIN: env.baseUrl,
            APP_CONFIG_TEST_EMAIL_LOGIN: String(env.testEmailLogin ?? false),
            APP_CONFIG_MCP_ORIGIN: env.mcpBaseUrl,
            APP_CONFIG_PROJECT_HOSTNAME_BASE: env.projectHostnameBase,
            APP_CONFIG_ARTIFACTS_ACCOUNT_ID: env.cloudflareAccountId,
            APP_CONFIG_ARTIFACTS_NAMESPACE: env.artifactsNamespace,
          },
        },
      ]),
    ),
  };
  return writeGeneratedWranglerConfig({
    configUrl: new URL("../wrangler.jsonc", import.meta.url),
    appLabel: "packages/v3/project-worker",
    config,
  });
}
if (process.argv[1]?.endsWith("generate-wrangler-config.ts")) console.log(writeWranglerConfig());
