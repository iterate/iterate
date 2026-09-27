import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createBuiltInPrompts, createCli, isAgent, yamlTableConsoleLogger } from "trpc-cli";
import { OS_DOPPLER_PROJECT, spaEnvs } from "../../../envs.ts";
import { resolveEnvContext } from "../../../scripts/lib/env-context.ts";
import { smokeResponse } from "../../../scripts/lib/deploy-helpers.ts";
import { COMPATIBILITY_DATE } from "../../../scripts/lib/wrangler-config.ts";
import { isMainModule } from "../../../packages/shared/src/dev/is-main-module.ts";

/** scripts/build.ts (static files + the packaged extension) → wrangler deploy → the deployed
 *  oauth.js, client logo and extension bundle match this checkout. */
export default async function deploy(options: { env?: string } = {}) {
  await import("./build.ts");
  const ctx = await resolveEnvContext({
    envs: spaEnvs,
    dopplerProject: OS_DOPPLER_PROJECT,
    env: options.env,
  });
  const config = new URL("../dist/wrangler.json", import.meta.url);
  writeFileSync(
    config,
    JSON.stringify({
      name: ctx.env.workerName,
      account_id: ctx.env.cloudflareAccountId,
      compatibility_date: COMPATIBILITY_DATE,
      assets: { directory: "./assets", not_found_handling: "single-page-application" },
      workers_dev: true,
    }),
  );
  execFileSync("pnpm", ["exec", "wrangler", "deploy", "--config", config.pathname], {
    stdio: "inherit",
    env: {
      ...process.env,
      CLOUDFLARE_API_TOKEN: ctx.secrets.CLOUDFLARE_API_TOKEN,
      CLOUDFLARE_ACCOUNT_ID: ctx.env.cloudflareAccountId,
    },
  });
  console.log(`Deployed ${ctx.env.baseUrl}`);

  const assets = new URL("../dist/assets/", import.meta.url);
  const bundle = readdirSync(new URL("downloads/", assets)).find((name) => name.endsWith(".zip"));
  if (!bundle) throw new Error("No packaged extension found");
  for (const path of ["oauth.js", "client-logo.svg", `downloads/${bundle}`]) {
    const expected = readFileSync(new URL(path, assets));
    await smokeResponse(
      new URL(path, ctx.env.baseUrl).href,
      async (response) => response.ok && expected.equals(Buffer.from(await response.arrayBuffer())),
      `deployed ${path} matches this checkout`,
    );
  }
}

if (isMainModule(import.meta.url)) {
  void createCli({ ...import.meta, name: "deploy" }).run({
    logger: yamlTableConsoleLogger,
    prompts: isAgent() ? undefined : createBuiltInPrompts(),
  });
}
