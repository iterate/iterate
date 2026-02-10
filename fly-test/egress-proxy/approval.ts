/**
 * In-process approval coordinator. Replaces the Durable Object from the CF version.
 *
 * Pending approvals are held open as Promises. When a decision comes in
 * (approve/reject) or the timeout fires, all waiting resolvers are notified.
 */

export type ApprovalDecision = "approved" | "rejected" | "timeout";

export type PendingApproval = {
  id: string;
  createdAt: number;
  method?: string;
  url?: string;
  reason?: string;
  /** "http" or "ws" */
  scope: string;
  /** Summary for viewer UI */
  summary: string;
};

type Entry = {
  approval: PendingApproval;
  resolvers: Array<(decision: ApprovalDecision) => void>;
  timer: ReturnType<typeof setTimeout>;
};

const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes

export type ApprovalCoordinator = {
  /** Create a pending approval and wait for a decision. */
  waitForDecision: (approval: PendingApproval, timeoutMs?: number) => Promise<ApprovalDecision>;
  /** Submit a decision for a pending approval. */
  decide: (approvalId: string, decision: ApprovalDecision) => boolean;
  /** List all currently pending approvals. */
  listPending: () => PendingApproval[];
  /** Get count of pending approvals. */
  pendingCount: () => number;
};

export function createApprovalCoordinator(): ApprovalCoordinator {
  const pending = new Map<string, Entry>();

  function resolve(approvalId: string, decision: ApprovalDecision): void {
    const entry = pending.get(approvalId);
    if (!entry) return;
    clearTimeout(entry.timer);
    for (const resolver of entry.resolvers) {
      resolver(decision);
    }
    pending.delete(approvalId);
  }

  function waitForDecision(
    approval: PendingApproval,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<ApprovalDecision> {
    return new Promise<ApprovalDecision>((resolvePromise) => {
      const existing = pending.get(approval.id);
      if (existing) {
        // Another waiter for the same approval
        existing.resolvers.push(resolvePromise);
        return;
      }

      const timer = setTimeout(() => {
        resolve(approval.id, "timeout");
      }, timeoutMs);

      pending.set(approval.id, {
        approval,
        resolvers: [resolvePromise],
        timer,
      });
    });
  }

  function decide(approvalId: string, decision: ApprovalDecision): boolean {
    if (!pending.has(approvalId)) return false;
    resolve(approvalId, decision);
    return true;
  }

  function listPending(): PendingApproval[] {
    return [...pending.values()].map((entry) => entry.approval);
  }

  return {
    waitForDecision,
    decide,
    listPending,
    pendingCount: () => pending.size,
  };
}
