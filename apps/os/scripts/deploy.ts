import { fileURLToPath } from "node:url";
import { createCli } from "trpc-cli";
import { OS_DOPPLER_PROJECT, osEnv, osEnvs, type OsEnv } from "../../../envs.ts";
import { deployApp } from "../../../scripts/lib/deploy-app.ts";
import type { EnvContext } from "../../../scripts/lib/env-context.ts";
import { build } from "./build.ts";
import { applyD1Migrations, ensureD1 } from "./d1.ts";
import { ensureArtifactsNamespace, isCloudflareError } from "./preview-artifacts.ts";

/** Deploy apps/os to `--env`, any name envs.ts `osEnv` knows: `prd` (Deploy OS), `preview` (main on
 *  dev, scripts/preview.ts `deploy-parents`) or a per-commit deployment's (`pr3144-a1b2c3d`,
 *  scripts/preview.ts `deploy`). */
export default async function deploy(options: {
  env: string;
  /** Deploy with no routes, beside the Worker its hostnames still reach (deployApp
   *  `withoutRoutes`): the first step of moving a deployment to a new Worker. */
  withoutRoutes?: boolean;
}) {
  const env = osEnv(options.env);
  if (!env)
    throw new Error(
      `apps/os: unknown env ${JSON.stringify(options.env)}; known: ${Object.keys(osEnvs).join(", ")}, or a per-commit deployment's <prefix>-<sha7>`,
    );
  await deployApp({
    withoutRoutes: options.withoutRoutes,
    appRoot: fileURLToPath(new URL("..", import.meta.url)),
    appLabel: "apps/os",
    name: options.env,
    env,
    dopplerProject: OS_DOPPLER_PROJECT,
    workerName: env.workerName,
    servingUrl: env.baseUrl,
    // a per-commit deployment's are created below, by name
    resources: env.resources || {},
    // The private login settings and at-rest key come from Doppler. Public URLs come from envs.ts.
    requiredSecrets: ["APP_CONFIG", "APP_CONFIG_SECRETS__KEY"],
    // The control plane's D1 is migrated before the code that reads it uploads, so a migration that
    // fails leaves the running version serving; a migration must keep that version working for the
    // minute until the upload (scripts/d1.ts).
    async prepare(ctx, _secretValues, credentials) {
      const [, databaseId] = await Promise.all([
        build(),
        ctx.env.resources?.dbId || createResources(ctx),
      ]);
      await applyD1Migrations(ctx.cf, {
        databaseName: `${ctx.env.resourceNamePrefix}-db`,
        databaseId,
        credentials: {
          CLOUDFLARE_API_TOKEN: credentials.CLOUDFLARE_API_TOKEN!,
          CLOUDFLARE_ACCOUNT_ID: credentials.CLOUDFLARE_ACCOUNT_ID!,
        },
      });
    },
    smokes: [
      { url: `${env.baseUrl}/version`, ok: (status) => status === 200, label: "version" },
      {
        url: `${env.baseUrl}/.well-known/oauth-authorization-server`,
        ok: (status) => status === 200,
        label: "OAuth discovery",
      },
      { url: env.mcpBaseUrl, ok: (status) => status === 401, label: "MCP bearer challenge" },
      {
        url: `${env.baseUrl}/api`,
        ok: (status) => status === 401,
        label: "Cap’n Web bearer challenge",
      },
    ],
  });
}
/** A per-commit deployment's D1, R2 bucket and Artifacts namespace, by the names its config binds
 *  (generate-wrangler-config.ts `deploymentWranglerConfig`), each found or created; the KV is
 *  wrangler's to create during the deploy. The D1 is created near this job (`automatic`, d1.ts
 *  `D1Location`), which in CI is where the deployment's suites call it from. Resolves to the D1's id. The delete that takes them is
 *  scripts/preview.ts `deletePreviewDeployment`. */
async function createResources(ctx: EnvContext<OsEnv>) {
  const bucketName = `${ctx.env.resourceNamePrefix}-files`;
  const [database] = await Promise.all([
    ensureD1(ctx.cf, `${ctx.env.resourceNamePrefix}-db`, "automatic"),
    ensureArtifactsNamespace(ctx.cf, ctx.env.artifactsNamespace),
    ctx.cf(`/r2/buckets/${bucketName}`).catch(async (error) => {
      if (!isCloudflareError(error, 404, 10006)) throw error;
      await ctx.cf("/r2/buckets", { method: "POST", body: JSON.stringify({ name: bucketName }) });
      console.log(`created R2 bucket ${bucketName}`);
    }),
  ]);
  return database.uuid;
}

if (process.argv[1]?.endsWith("deploy.ts"))
  void createCli({ ...import.meta, name: "deploy" }).run();
