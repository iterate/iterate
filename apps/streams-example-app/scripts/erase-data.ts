/**
 * Erase the streams playground's Durable Objects without deleting its
 * Worker, route, DNS, or any other infrastructure.
 *
 * Preview handover invokes this alongside OS's broader data wipe so the
 * stable root StreamDurableObject cannot carry schema or events between PRs.
 */
import { fileURLToPath } from "node:url";
import { createBuiltInPrompts, createCli, isAgent, yamlTableConsoleLogger } from "trpc-cli";
import { streamsExampleEnvs } from "../../../envs.ts";
import { resetWorkerDurableObjects } from "../../../scripts/lib/do-reset.ts";
import { resolveEnvContext } from "../../../scripts/lib/env-context.ts";
import { COMPATIBILITY_DATE } from "./generate-wrangler-config.ts";

export default async function eraseData(options: {
  /** Target environment name from envs.ts. Required for every destructive invocation. */
  env: string;
  /** Confirm erasing production data (required when --env prd). */
  yesIMeanPrd?: boolean;
}) {
  const ctx = await resolveEnvContext({
    envs: streamsExampleEnvs,
    dopplerProject: "streams-example-app",
    env: options.env,
  });
  if (ctx.name === "prd" && !options.yesIMeanPrd) {
    throw new Error("Refusing to erase PRODUCTION data without --yes-i-mean-prd.");
  }

  await resetWorkerDurableObjects({
    ctx,
    workerName: ctx.env.workerName,
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    credentials: {
      CLOUDFLARE_API_TOKEN: ctx.secrets.CLOUDFLARE_API_TOKEN,
      CLOUDFLARE_ACCOUNT_ID: ctx.env.cloudflareAccountId,
    },
    compatibilityDate: COMPATIBILITY_DATE,
  });
  console.log(`✅ ${ctx.name} streams playground data erased; worker and infrastructure remain.`);
}

void createCli({ ...import.meta, name: "erase-data" }).run({
  logger: yamlTableConsoleLogger,
  prompts: isAgent() ? undefined : createBuiltInPrompts(),
});
