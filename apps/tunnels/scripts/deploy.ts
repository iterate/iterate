/**
 * Deploy apps/tunnels (the captun gateway):
 *
 *   pnpm run deploy --env prd
 *
 * No build step: wrangler bundles the TypeScript entry itself. Secrets ride
 * `wrangler deploy --secrets-file`, so code + secrets land in one version
 * (after adopting the DO migration tag on alchemy-era scripts — see
 * deploy-helpers.ts).
 *
 * CAUTION: never delete tunnels-prd. Every dev environment's public tunnels
 * ride it, and force-deleting a worker script CASCADES its zone routes —
 * re-uploading does not bring them back (the zombie-route/522 class). Always
 * deploy over the live worker.
 */
import { fileURLToPath } from "node:url";
import { tunnelsEnvs } from "../../../envs.ts";
import {
  adoptDoMigrationTag,
  deployWithSecrets,
  smoke,
} from "../../../scripts/lib/deploy-helpers.ts";
import { resolveEnvContext } from "../../../scripts/lib/env-context.ts";

const APP_ROOT = fileURLToPath(new URL("..", import.meta.url));

const ctx = await resolveEnvContext({ envs: tunnelsEnvs, dopplerProject: "tunnels" });
console.log(
  `Deploying apps/tunnels to ${ctx.name} (worker ${ctx.env.workerName}, account ${ctx.env.cloudflareAccountId})`,
);

const captunToken = ctx.secrets.CAPTUN_TOKEN;
if (!captunToken) {
  throw new Error(
    `Doppler config ${ctx.env.dopplerConfig} is missing CAPTUN_TOKEN. ` +
      `Set it (doppler secrets set --project tunnels --config ${ctx.env.dopplerConfig} ...) and retry.`,
  );
}

await adoptDoMigrationTag(ctx, ctx.env.workerName);

// The checked-in wrangler.jsonc carries the env blocks, so deploy selects one
// with --env instead of a built per-env config.
await deployWithSecrets({
  cwd: APP_ROOT,
  builtConfig: "wrangler.jsonc",
  extraDeployArgs: ["--env", ctx.name],
  secretValues: { CAPTUN_TOKEN: captunToken },
  credentials: {
    CLOUDFLARE_API_TOKEN: ctx.secrets.CLOUDFLARE_API_TOKEN,
    CLOUDFLARE_ACCOUNT_ID: ctx.env.cloudflareAccountId,
  },
});

await smoke(`https://${ctx.env.hostname}/`, (status) => status < 500, "gateway");
console.log(`✅ ${ctx.name} deployed and serving at https://${ctx.env.hostname}`);
