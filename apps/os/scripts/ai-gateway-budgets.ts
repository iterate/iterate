import { createCli } from "trpc-cli";
import { envs } from "../../../envs.ts";
import { resolveEnvContext } from "../../../scripts/lib/env-context.ts";
import { productionRules, developmentRules } from "./ai-gateway-budget-rules.ts";
import { applyGatewayBudgets } from "./ai-gateway-budget-apply.ts";

/** Account-level ownership: never called by a normal Worker deployment. */
export default async function budgets(options: {
  env: string;
  /** Print the diff only unless this is explicitly enabled. */
  apply: boolean;
  /** Exact previously reviewed dashboard rule IDs to replace during adoption. */
  replaceRuleIds: string[];
}) {
  const ctx = await resolveEnvContext({ envs, dopplerProject: "os", env: options.env });
  const production = ctx.env.cloudflareAccountId === envs.prd.cloudflareAccountId;
  return applyGatewayBudgets({
    cf: ctx.cf,
    gatewayId: "default",
    rules: production ? productionRules() : developmentRules(),
    replaceRuleIds: options.replaceRuleIds,
    apply: options.apply,
  });
}
void createCli({ ...import.meta, name: "ai-gateway-budgets" }).run();
