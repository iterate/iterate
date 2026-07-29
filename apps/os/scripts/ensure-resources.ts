/**
 * Ensure a deployed environment's Cloudflare resources exist:
 *
 *   pnpm ensure-resources --env preview_9
 *
 * Alchemy owns D1, KV, and R2. This script retains the Wrangler-adjacent
 * hostname and Email Routing setup that must follow Worker route conventions.
 *
 * Run this explicitly when bringing up a new environment; normal deploys do
 * not mutate DNS or Email Routing.
 */
import { createBuiltInPrompts, createCli, isAgent, yamlTableConsoleLogger } from "trpc-cli";
import { envs } from "../../../envs.ts";
import { ensureProxiedDnsRecord } from "../../../scripts/lib/deploy-helpers.ts";
import { resolveEnvContext } from "../../../scripts/lib/env-context.ts";
import { ensureInboundEmailRouting } from "./email-routing-resources.ts";

/** Ensure apps/os's Cloudflare resources exist for an environment (create-only, idempotent). */
export default async function ensureResources(
  options: {
    /** Target environment name from envs.ts (falls back to DOPPLER_CONFIG in CI). */
    env?: string;
  } = {},
) {
  const ctx = await resolveEnvContext({
    envs,
    dopplerProject: "os",
    env: options.env,
    allowDopplerConfigFallback: true,
  });
  const { env, cfV4 } = ctx;
  console.log(`Ensuring resources for ${ctx.name} in account ${env.cloudflareAccountId}`);

  // ---- DNS: proxied records for every routed hostname --------------------------
  // Worker zone routes only fire when a proxied DNS record answers the
  // hostname. Wrangler's custom_domains can't cover wildcards, so ensure the
  // records here (create-only; deploys never touch DNS).
  const hostRecords = [
    new URL(env.baseUrl).hostname,
    new URL(env.eventDocsBaseUrl).hostname,
    new URL(env.mcpBaseUrl).hostname,
    ...env.projectHostnameBases.flatMap((base) => [base, `*.${base}`]),
  ];
  const zones = await cfV4<{ id: string; name: string }[]>(
    `/zones?account.id=${env.cloudflareAccountId}&per_page=500`,
  );
  for (const host of hostRecords) {
    await ensureProxiedDnsRecord(
      ctx,
      zones,
      host,
      `iterate ${ctx.name} os worker route host (ensure-resources.ts)`,
    );
  }

  // ---- Email Routing: inbound project email -------------------------------
  // Cloudflare accepts a Worker action only after that script exists. A fresh
  // slot therefore enables routing now and explicitly defers the catch-all;
  // deploy.ts requires and installs it after the first Worker upload.
  await ensureInboundEmailRouting(ctx, {
    projectHostnameBases: env.projectHostnameBases,
    workerName: env.osWorkerName,
    workerRequirement: "allow-missing-before-first-deploy",
  });
}

void createCli({ ...import.meta, name: "ensure-resources" }).run({
  logger: yamlTableConsoleLogger,
  prompts: isAgent() ? undefined : createBuiltInPrompts(),
});
