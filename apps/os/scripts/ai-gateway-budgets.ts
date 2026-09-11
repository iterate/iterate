import { isDeepStrictEqual } from "node:util";
import { createCli } from "trpc-cli";
import type {
  AIGatewayGetResponse,
  AIGatewayUpdateParams,
} from "cloudflare/resources/ai-gateway/ai-gateway";
import { envs } from "../../../envs.ts";
import { resolveEnvContext } from "../../../scripts/lib/env-context.ts";

/** Account-level rules, reconciled after the main production deployment. */
export default async function budgets(options: {
  env: string;
  /** Print the diff only unless this is explicitly enabled. */
  apply: boolean;
  /** Exact previously reviewed dashboard rule IDs to replace during adoption. */
  replaceRuleIds: string[];
}) {
  const ctx = await resolveEnvContext({ envs, dopplerProject: "os", env: options.env });
  const production = ctx.env.cloudflareAccountId === envs.prd.cloudflareAccountId;
  const gatewayId = "default";
  const rules = production ? productionRules() : nonProductionRules();
  const path = `/ai-gateway/gateways/${gatewayId}`;
  const current = await ctx.cf<AIGatewayGetResponse>(path);
  const owned = new Set([...rules.map((rule) => rule.id), ...options.replaceRuleIds]);
  const unexpected = current.spend_limits?.rules?.filter((rule) => !owned.has(rule.id)) || [];
  const before = current.spend_limits || null;
  const after = { enabled: true, rules };
  console.log(
    JSON.stringify(
      {
        gatewayId,
        before,
        after,
        unownedRuleIds: unexpected.map((rule) => rule.id),
        counterEffect: "Changed rules start fresh spending counters",
      },
      null,
      2,
    ),
  );
  if (!options.apply) return { before, after, changed: false };
  if (unexpected.length)
    throw new Error(
      `Gateway has unowned rules: ${unexpected.map((rule) => rule.id).join(", ")}. Review before explicitly replacing them.`,
    );
  if (isDeepStrictEqual(before, after)) return { before, after, changed: false };
  // GET's timestamps and identity are response-only. Preserve the complete
  // writable settings instead of resetting auth, logging, caching, or retries.
  const { id: _id, created_at: _created, modified_at: _modified, ...settings } = current;
  await ctx.cf(path, {
    method: "PUT",
    body: JSON.stringify({ ...settings, spend_limits: after }),
  });
  const actual = await ctx.cf<AIGatewayGetResponse>(path);
  if (!isDeepStrictEqual(actual.spend_limits, after))
    throw new Error("AI Gateway did not persist the requested budget rules");
  return { before, after, changed: true };
}
/** Rolling budgets in USD; Cloudflare's window is seconds. */
function productionRules(): AIGatewayUpdateParams.SpendLimits.Rule[] {
  return [
    {
      id: "iterate-gateway-daily",
      enabled: true,
      limitType: "cost",
      limit: 30,
      window: 86_400,
      technique: "sliding",
    },
    {
      id: "iterate-project-daily",
      enabled: true,
      limitType: "cost",
      limit: 10,
      window: 86_400,
      technique: "sliding",
      metadata: { environment: { mode: "partition" }, projectId: { mode: "partition" } },
    },
    {
      id: "iterate-stream-hourly",
      enabled: true,
      limitType: "cost",
      limit: 3,
      window: 3_600,
      technique: "sliding",
      metadata: {
        environment: { mode: "partition" },
        projectId: { mode: "partition" },
        streamPath: { mode: "partition" },
      },
    },
  ];
}

/** Rolling budgets in USD; Cloudflare's window is seconds. */
function nonProductionRules(): AIGatewayUpdateParams.SpendLimits.Rule[] {
  return [
    {
      id: "iterate-gateway-daily",
      enabled: true,
      limitType: "cost",
      limit: 10,
      window: 86_400,
      technique: "sliding",
    },
    {
      id: "iterate-project-daily",
      enabled: true,
      limitType: "cost",
      limit: 10,
      window: 86_400,
      technique: "sliding",
      metadata: { environment: { mode: "partition" }, projectId: { mode: "partition" } },
    },
    {
      id: "iterate-stream-hourly",
      enabled: true,
      limitType: "cost",
      limit: 3,
      window: 3_600,
      technique: "sliding",
      metadata: {
        environment: { mode: "partition" },
        projectId: { mode: "partition" },
        streamPath: { mode: "partition" },
      },
    },
  ];
}

void createCli({ ...import.meta, name: "ai-gateway-budgets" }).run();
