import type * as schema from "../db/schema.ts";

export type PolicyDecision = "allow" | "deny" | "human_approval";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "timeout";
/** Decision values that can be returned from approval coordinator */
export type DecisionStatus = "approved" | "rejected" | "timeout";
export type EgressPolicy = typeof schema.egressPolicy.$inferSelect;
export type EgressApproval = typeof schema.egressApproval.$inferSelect;

export type PolicyCheckResult = {
  decision: PolicyDecision;
  policy?: EgressPolicy;
  reason?: string | null;
};
