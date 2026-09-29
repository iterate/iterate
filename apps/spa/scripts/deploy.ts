import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createBuiltInPrompts, createCli, isAgent, yamlTableConsoleLogger } from "trpc-cli";
import { OS_DOPPLER_PROJECT, getDeployableEnv, spaEnvs } from "../../../envs.ts";
import { deployApp } from "../../../scripts/lib/deploy-app.ts";
import { smoke } from "../../../scripts/lib/deploy-helpers.ts";
import { COMPATIBILITY_DATE } from "../../../scripts/lib/wrangler-config.ts";
import { isMainModule } from "../../../packages/shared/src/dev/is-main-module.ts";

const assets = new URL("../dist/assets/", import.meta.url);

/** scripts/build.ts (static files + the packaged extension), an assets-only Worker's config beside
 *  them, deployed (scripts/lib/deploy-app.ts); then the deployed oauth.js, client logo and extension
 *  bundle match this checkout. */
export default async function deploy(options: { env: string }) {
  const env = getDeployableEnv(options.env, spaEnvs);
  await deployApp({
    env,
    dopplerProject: OS_DOPPLER_PROJECT,
    appRoot: fileURLToPath(new URL("..", import.meta.url)),
    appLabel: "apps/spa",
    async build(ctx) {
      await import("./build.ts");
      writeFileSync(
        new URL("../dist/wrangler.json", import.meta.url),
        JSON.stringify({
          name: ctx.env.workerName,
          account_id: ctx.env.cloudflareAccountId,
          compatibility_date: COMPATIBILITY_DATE,
          assets: { directory: "./assets", not_found_handling: "single-page-application" },
          workers_dev: true,
        }),
      );
    },
    smokes: [],
    // The extension zip's name comes from the build, so these probes run after the deploy rather
    // than as `smokes`. A status alone could be the single-page fallback's: each file's bytes are
    // the build's.
    async afterDeploy() {
      const bundle = readdirSync(new URL("downloads/", assets)).find((name) =>
        name.endsWith(".zip"),
      );
      if (!bundle) throw new Error("No packaged extension found");
      for (const path of ["oauth.js", "client-logo.svg", `downloads/${bundle}`])
        await smoke(
          new URL(path, env.baseUrl).href,
          async (response) =>
            response.ok &&
            readFileSync(new URL(path, assets)).equals(Buffer.from(await response.arrayBuffer())),
          `deployed ${path} matches this checkout`,
        );
    },
  });
}

if (isMainModule(import.meta.url)) {
  void createCli({ ...import.meta, name: "deploy" }).run({
    logger: yamlTableConsoleLogger,
    prompts: isAgent() ? undefined : createBuiltInPrompts(),
  });
}
