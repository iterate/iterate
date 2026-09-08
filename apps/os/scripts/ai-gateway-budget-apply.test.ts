import { expect, test } from "vitest";
import { applyGatewayBudgets } from "./ai-gateway-budget-apply.ts";
import { productionRules, developmentRules } from "./ai-gateway-budget-rules.ts";

test("applying budgets preserves gateway settings, verifies persistence, and avoids counter-resetting no-op writes", async () => {
  let gateway: any = {
    id: "default",
    created_at: "today",
    modified_at: "today",
    authentication: true,
    cache_ttl: 500,
    log_management: 1000,
    spend_limits: { enabled: true, rules: [{ id: "legacy" }] },
  };
  const writes: any[] = [];
  const cf = async (_path: string, init?: RequestInit): Promise<any> => {
    if (init?.method === "PUT") {
      gateway = JSON.parse(String(init.body));
      writes.push(gateway);
    }
    return gateway;
  };
  const input = {
    cf,
    gatewayId: "default",
    rules: productionRules(),
    replaceRuleIds: ["legacy"],
    apply: true,
  };
  expect(await applyGatewayBudgets({ ...input, apply: false })).toMatchObject({ changed: false });
  expect(writes).toHaveLength(0);
  expect(await applyGatewayBudgets(input)).toMatchObject({ changed: true });
  expect(writes).toEqual([
    {
      authentication: true,
      cache_ttl: 500,
      log_management: 1000,
      spend_limits: { enabled: true, rules: productionRules() },
    },
  ]);
  expect(await applyGatewayBudgets(input)).toMatchObject({ changed: false });
  expect(writes).toHaveLength(1);
});

test("unknown dashboard rules and ignored updates stop account reconciliation", async () => {
  let writes = 0;
  const cf = async (_path: string, init?: RequestInit): Promise<any> => {
    if (init?.method === "PUT") writes++;
    return {
      id: "default",
      spend_limits: { enabled: true, rules: [{ id: "someone-elses-rule" }] },
    };
  };
  const input = {
    cf,
    gatewayId: "default",
    rules: developmentRules(),
    replaceRuleIds: [],
    apply: true,
  };
  await expect(applyGatewayBudgets(input)).rejects.toThrow("unowned rules");
  expect(writes).toBe(0);
  await expect(
    applyGatewayBudgets({ ...input, replaceRuleIds: ["someone-elses-rule"] }),
  ).rejects.toThrow("did not persist");
  expect(writes).toBe(1);
});
