import { fileURLToPath } from "node:url";
import { createCli } from "trpc-cli";
import { OS_DOPPLER_PROJECT, getOsEnv, type OsDeployableEnv } from "../../../envs.ts";
import { deployApp } from "../../../scripts/lib/deploy-app.ts";
import { appConfigSecretsOf } from "../../../scripts/lib/deploy-helpers.ts";
import type { EnvContext } from "../../../scripts/lib/env-context.ts";
import { parseAppConfig } from "../src/app-config.ts";
import { build } from "./build.ts";
import { applyD1Migrations, ensureD1 } from "./d1.ts";
import { viteWranglerConfig } from "./generate-wrangler-config.ts";
import { osResourceNames } from "./os-env.ts";
import { ensureArtifactsNamespace, isCloudflareError } from "./preview-artifacts.ts";
import { PREVIEW_GITHUB_APP, previewGithubAppPrivateKey } from "./preview-github-app.ts";

/** Deploy apps/os to `--env`, any name envs.ts `getOsEnv` knows: `prd` (Deploy OS), `preview` (main on
 *  dev, scripts/preview.ts `deploy-parents`) or a per-commit deployment's (`pr3144-a1b2c3d`,
 *  scripts/preview.ts `deploy`). */
export default async function deploy(options: {
  env: string;
  /** Deploy with no routes, beside the Worker its hostnames still reach (deployApp
   *  `withoutRoutes`): the first step of moving a deployment to a new Worker. */
  withoutRoutes?: boolean;
}) {
  const env = getOsEnv(options.env);
  await deployApp(env, {
    dopplerProject: OS_DOPPLER_PROJECT,
    withoutRoutes: options.withoutRoutes,
    appRoot: fileURLToPath(new URL("..", import.meta.url)),
    appLabel: "apps/os",
    // The private login settings and at-rest key come from Doppler. Public URLs come from envs.ts.
    requiredSecrets: ["APP_CONFIG", "APP_CONFIG_SECRETS__KEY"],
    // The configuration is checked first, as the Worker will read it: the generated vars and these
    // secrets (it holds no others; `--secrets-file` would keep any). A malformed field fails the
    // deploy here while the running version keeps serving; a key the schema does not name is only
    // warned about, as the Worker does, since another branch may have added it. The
    // control plane's D1 is migrated before the code that reads it uploads, so a migration that
    // fails leaves the running version serving; a migration must keep that version working for the
    // minute until the upload (scripts/d1.ts).
    async prepare(ctx, secretValues, credentials) {
      // every APP_CONFIG* var in the Doppler config, not only the two required below
      Object.assign(secretValues, appConfigSecretsOf(ctx.secrets));
      // The pet shop's GitHub fake as iterate's GitHub App (generate-wrangler-config.ts has the other
      // fakes): its throwaway key is Doppler `os/preview`'s, so the App ships as a secret, not a var.
      if (ctx.env.petshopIntegrations)
        secretValues.APP_CONFIG_INTEGRATIONS__GITHUB = JSON.stringify({
          ...PREVIEW_GITHUB_APP,
          privateKey: previewGithubAppPrivateKey(),
        });
      parseAppConfig({
        ...viteWranglerConfig(env.name, { localDev: false, port: "" }).vars,
        ...secretValues,
      });
      const [, databaseId] = await Promise.all([
        build(),
        ctx.env.resources?.dbId || createResources(ctx),
      ]);
      await applyD1Migrations(ctx.cf, {
        databaseName: osResourceNames(ctx.env.resourceNamePrefix).db,
        databaseId,
        credentials: {
          CLOUDFLARE_API_TOKEN: credentials.CLOUDFLARE_API_TOKEN!,
          CLOUDFLARE_ACCOUNT_ID: credentials.CLOUDFLARE_ACCOUNT_ID!,
        },
      });
    },
    smokes: [
      {
        url: "/version",
        ok: (response) => response.status === 200,
        label: "version",
      },
      {
        url: "/.well-known/oauth-authorization-server",
        ok: (response) => response.status === 200,
        label: "OAuth discovery",
      },
      {
        url: env.mcpBaseUrl,
        ok: (response) => response.status === 401,
        label: "MCP bearer challenge",
      },
      {
        url: "/api",
        ok: (response) => response.status === 401,
        label: "Cap’n Web bearer challenge",
      },
    ],
  });
}
/** A per-commit deployment's D1, R2 bucket and Artifacts namespace, by the names its config binds
 *  (generate-wrangler-config.ts `deploymentWranglerConfig`), each found or created; the KV is
 *  wrangler's to create during the deploy. The D1 is created near this job (`automatic`, d1.ts
 *  `D1Location`), which in CI is where the deployment's suites call it from. Resolves to the D1's id. The delete that takes them is
 *  scripts/preview-delete.ts `deletePreviewDeployments`. */
async function createResources(ctx: EnvContext<OsDeployableEnv>) {
  const names = osResourceNames(ctx.env.resourceNamePrefix);
  const [database] = await Promise.all([
    ensureD1(ctx.cf, names.db, "automatic"),
    ensureArtifactsNamespace(ctx.cf, names.repos),
    ctx.cf(`/r2/buckets/${names.files}`).catch(async (error) => {
      if (!isCloudflareError(error, 404, 10006)) throw error;
      await ctx.cf("/r2/buckets", { method: "POST", body: JSON.stringify({ name: names.files }) });
      console.log(`created R2 bucket ${names.files}`);
    }),
  ]);
  return database.uuid;
}

if (process.argv[1]?.endsWith("deploy.ts"))
  void createCli({ ...import.meta, name: "deploy" }).run();
