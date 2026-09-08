import type { AIGatewayUpdateParams } from "cloudflare/resources/ai-gateway/ai-gateway";

type SpendRule = AIGatewayUpdateParams.SpendLimits.Rule;

/** Rolling budgets in dollars; Cloudflare's window is seconds. */
export function productionRules(): SpendRule[] {
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

/** Rolling budgets in dollars; Cloudflare's window is seconds. */
export function developmentRules(): SpendRule[] {
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
