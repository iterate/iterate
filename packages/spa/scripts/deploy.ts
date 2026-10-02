import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createBuiltInPrompts, createCli, isAgent, yamlTableConsoleLogger } from "trpc-cli";
import { COMPATIBILITY_DATE } from "iterate/compatibility-date";
import { z } from "zod";
import { OS_DOPPLER_PROJECT, getEnv, spaEnvs } from "../../../envs.ts";
import { deployApp } from "../../../scripts/lib/deploy-app.ts";

const assets = new URL("../dist/assets/", import.meta.url);
/** The packaged extension's version, which scripts/build.ts names the download after. */
const extensionManifest = new URL("../../browser-extension/public/manifest.json", import.meta.url);

/** scripts/build.ts (static files + the packaged extension), an assets-only Worker's config beside
 *  them, deployed (scripts/lib/deploy-app.ts); then the deployed oauth.js, client logo and extension
 *  bundle match this checkout. */
export default async function deploy(options: { env: string }) {
  const { version } = z
    .object({ version: z.string() })
    .parse(JSON.parse(readFileSync(extensionManifest, "utf8")));
  await deployApp(getEnv(options.env, spaEnvs), {
    dopplerProject: OS_DOPPLER_PROJECT,
    appRoot: fileURLToPath(new URL("..", import.meta.url)),
    appLabel: "packages/spa",
    async build(ctx) {
      // ./build.ts runs the extension's build, which adds this key to the manifest it zips
      process.env.CHROME_EXTENSION_KEY = ctx.env.chromeExtensionKey;
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
    smokes: [
      "/oauth.js",
      "/client-logo.svg",
      `/downloads/iterate-chrome-extension-${version}.zip`,
    ].map((path) => ({
      url: path,
      ok: async (response) =>
        response.ok &&
        readFileSync(new URL(`.${path}`, assets)).equals(Buffer.from(await response.arrayBuffer())),
      label: `deployed ${path} matches this checkout`,
    })),
  });
}

void createCli(import.meta).run({
  logger: yamlTableConsoleLogger,
  prompts: isAgent() ? undefined : createBuiltInPrompts(),
});
