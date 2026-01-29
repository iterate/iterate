import { asc, eq } from "drizzle-orm";
import type { DB } from "../db/client.ts";
import * as schema from "../db/schema.ts";
import type { PolicyCheckResult } from "./types.ts";
import { matchesEgressRule } from "./egress-rules.ts";

type PolicyRow = typeof schema.egressPolicy.$inferSelect;

type PolicyRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string | null;
};

export async function checkEgressPolicy(
  request: PolicyRequest,
  projectId: string,
  db: DB,
): Promise<PolicyCheckResult> {
  const policies = await db.query.egressPolicy.findMany({
    where: eq(schema.egressPolicy.projectId, projectId),
    orderBy: [asc(schema.egressPolicy.priority)],
  });

  // Headers are already lowercased by headersToRecord in egress-proxy.ts
  for (const policy of policies as PolicyRow[]) {
    if (!policy.urlPattern) {
      continue;
    }
    const matched = await matchesEgressRule(
      request.url,
      policy.urlPattern,
      request.headers,
      request.body ?? undefined,
      request.method,
    );
    if (matched) {
      return {
        decision: policy.decision,
        policy,
        reason: policy.reason ?? undefined,
      };
    }
  }

  return { decision: "allow", reason: "no_matching_policy" };
}
