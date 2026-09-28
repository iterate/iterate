import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createBuiltInPrompts, createCli, isAgent, yamlTableConsoleLogger } from "trpc-cli";
import { OS_DOPPLER_PROJECT, spaEnvs } from "../../../envs.ts";
import { deployApp } from "../../../scripts/lib/deploy-app.ts";
import { COMPATIBILITY_DATE } from "../../../scripts/lib/wrangler-config.ts";
import { isMainModule } from "../../../packages/shared/src/dev/is-main-module.ts";

const assets = new URL("../dist/assets/", import.meta.url);

/** scripts/build.ts (static files + the packaged extension), an assets-only Worker's config beside
 *  them, deployed (scripts/lib/deploy-app.ts); then the deployed oauth.js, client logo and extension
 *  bundle match this checkout. */
export default async function deploy(options: { env: string }) {
  await deployApp({
    appRoot: fileURLToPath(new URL("..", import.meta.url)),
    appLabel: "apps/spa",
    envs: spaEnvs,
    dopplerProject: OS_DOPPLER_PROJECT,
    env: options.env,
    workerName: (env) => env.workerName,
    servingUrl: (env) => env.baseUrl,
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
    // A status alone could be the single-page fallback's: each file's bytes are the build's.
    smokes: (env) => {
      const bundle = readdirSync(new URL("downloads/", assets)).find((name) =>
        name.endsWith(".zip"),
      );
      if (!bundle) throw new Error("No packaged extension found");
      return ["oauth.js", "client-logo.svg", `downloads/${bundle}`].map((path) => ({
        url: new URL(path, env.baseUrl).href,
        ok: async (response: Response) =>
          response.ok &&
          readFileSync(new URL(path, assets)).equals(Buffer.from(await response.arrayBuffer())),
        label: `deployed ${path} matches this checkout`,
      }));
    },
  });
}

if (isMainModule(import.meta.url)) {
  void createCli({ ...import.meta, name: "deploy" }).run({
    logger: yamlTableConsoleLogger,
    prompts: isAgent() ? undefined : createBuiltInPrompts(),
  });
}
