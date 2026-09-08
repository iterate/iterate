import { isDeepStrictEqual } from "node:util";
import type {
  AIGatewayGetResponse,
  AIGatewayUpdateParams,
} from "cloudflare/resources/ai-gateway/ai-gateway";
import type { EnvContext } from "../../../scripts/lib/env-context.ts";
import type { DeployedEnv } from "../../../envs.ts";

/** Update only an explicitly owned rule set; a successful HTTP response is insufficient proof. */
export async function applyGatewayBudgets(input: {
  cf: EnvContext<DeployedEnv>["cf"];
  gatewayId: string;
  rules: AIGatewayUpdateParams.SpendLimits.Rule[];
  replaceRuleIds: string[];
  apply: boolean;
}) {
  const path = `/ai-gateway/gateways/${input.gatewayId}`;
  const current = await input.cf<AIGatewayGetResponse>(path);
  const owned = new Set([...input.rules.map((rule) => rule.id), ...input.replaceRuleIds]);
  const unexpected = current.spend_limits?.rules?.filter((rule) => !owned.has(rule.id)) || [];
  const before = current.spend_limits || null;
  const after = { enabled: true, rules: input.rules };
  console.log(
    JSON.stringify(
      {
        gatewayId: input.gatewayId,
        before,
        after,
        unownedRuleIds: unexpected.map((rule) => rule.id),
        counterEffect: "Changed rules start fresh spending counters",
      },
      null,
      2,
    ),
  );
  if (!input.apply) return { before, after, changed: false };
  if (unexpected.length)
    throw new Error(
      `Gateway has unowned rules: ${unexpected.map((rule) => rule.id).join(", ")}. Review before explicitly replacing them.`,
    );
  if (isDeepStrictEqual(before, after)) return { before, after, changed: false };
  // GET's timestamps and identity are response-only. Preserve the complete
  // writable settings instead of resetting auth, logging, caching, or retries.
  const { id: _id, created_at: _created, modified_at: _modified, ...settings } = current;
  await input.cf(path, {
    method: "PUT",
    body: JSON.stringify({ ...settings, spend_limits: after }),
  });
  const actual = await input.cf<AIGatewayGetResponse>(path);
  if (!isDeepStrictEqual(actual.spend_limits, after))
    throw new Error("AI Gateway did not persist the requested budget rules");
  return { before, after, changed: true };
}
