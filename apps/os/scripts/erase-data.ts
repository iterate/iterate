/**
 * Erase one deployed environment:
 *
 *   pnpm erase-data --env preview_3
 *   pnpm erase-data --env prd --yes-i-mean-prd
 *
 * Wrangler-owned Workers, routes, DNS, and container classes remain. Durable
 * Object instances are reset first so no live alarm can write while Alchemy
 * destroys the environment's D1, KV, and R2 resources.
 */
import { fileURLToPath } from "node:url";
import { createBuiltInPrompts, createCli, isAgent, yamlTableConsoleLogger } from "trpc-cli";
import { envs } from "../../../envs.ts";
import { removeWorkerSecrets, run } from "../../../scripts/lib/deploy-helpers.ts";
import { resetWorkerDurableObjects } from "../../../scripts/lib/do-reset.ts";
import { resolveEnvContext } from "../../../scripts/lib/env-context.ts";
import {
  SANDBOX_INSTANCE_TYPE_BINDINGS,
  SANDBOX_INSTANCE_TYPES,
} from "../src/domains/sandboxes/instance-types.ts";
import { COMPATIBILITY_DATE, RETIRED_WORKER_SECRETS } from "./generate-wrangler-config.ts";

export default async function eraseData(options: {
  /** Target environment name from envs.ts. Destructive scripts never infer their target. */
  env: string;
  /** Confirm erasing PRODUCTION data (required when --env prd). */
  yesIMeanPrd?: boolean;
}) {
  const ctx = await resolveEnvContext({ envs, dopplerProject: "os", env: options.env });
  const { env, cf } = ctx;

  if (ctx.name === "prd" && !options.yesIMeanPrd) {
    throw new Error("Refusing to erase PRODUCTION data without --yes-i-mean-prd.");
  }
  console.log(`Erasing ${ctx.name} (worker ${env.osWorkerName})`);

  // A parked slot can outlive this checkout, so it must not retain retired
  // credentials that a later tenant could accidentally reactivate.
  await removeWorkerSecrets({
    cf,
    workerName: env.osWorkerName,
    secretNames: RETIRED_WORKER_SECRETS,
  });
  await resetWorkerDurableObjects({
    ctx,
    workerName: env.osWorkerName,
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    credentials: {
      CLOUDFLARE_API_TOKEN: ctx.secrets.CLOUDFLARE_API_TOKEN,
      CLOUDFLARE_ACCOUNT_ID: env.cloudflareAccountId,
    },
    compatibilityDate: COMPATIBILITY_DATE,
    containerClassNames: SANDBOX_INSTANCE_TYPES.map(
      (instanceType) => SANDBOX_INSTANCE_TYPE_BINDINGS[instanceType].className,
    ),
  });
  run(
    "pnpm",
    [
      "infra",
      "destroy",
      "--env",
      ctx.name,
      "--after-worker-data-reset",
      ...(ctx.name === "prd" ? ["--yes-i-mean-prd"] : []),
    ],
    {
      cwd: fileURLToPath(new URL("../../..", import.meta.url)),
    },
  );

  console.log(`✅ ${ctx.name} data stack and Durable Objects destroyed.`);
  console.log("   Workers and routes remain parked until the next deploy.");
}

void createCli({ ...import.meta, name: "erase-data" }).run({
  logger: yamlTableConsoleLogger,
  prompts: isAgent() ? undefined : createBuiltInPrompts(),
});
