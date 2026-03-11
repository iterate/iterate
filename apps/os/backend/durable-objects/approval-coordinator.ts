import { DurableObject } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { getDbWithEnv } from "../db/client.ts";
import * as schema from "../db/schema.ts";
import { logger } from "../tag-logger.ts";
import type { ApprovalStatus, DecisionStatus } from "../egress-proxy/types.ts";

/** Minimal env interface to avoid circular dependency with CloudflareEnv */
type DurableObjectEnv = { DATABASE_URL: string };

type Resolver = (decision: DecisionStatus) => void;

// Decision entries expire after 1 hour (they're only needed while the request is waiting)
const DECISION_TTL_MS = 60 * 60 * 1000;

function isDecisionStatus(value: string): value is DecisionStatus {
  return value === "approved" || value === "rejected" || value === "timeout";
}

export class ApprovalCoordinator extends DurableObject<DurableObjectEnv> {
  private pending = new Map<string, Resolver[]>();

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/wait/")) {
      const approvalId = url.pathname.split("/")[2];
      const timeoutMs = Number(url.searchParams.get("timeout") ?? "300000");
      const decision = await this.waitForDecision(approvalId, Math.max(0, timeoutMs));
      return new Response(decision);
    }

    if (url.pathname.startsWith("/decide/")) {
      const approvalId = url.pathname.split("/")[2];
      const decision = (await request.text()).trim();
      if (!isDecisionStatus(decision)) {
        return new Response("Invalid decision", { status: 400 });
      }
      await this.resolveDecision(approvalId, decision);
      return new Response("ok");
    }

    return new Response("not found", { status: 404 });
  }

  async alarm() {
    const now = Date.now();

    // Process timeout alarms
    const alarms = await this.ctx.storage.list<number>({ prefix: "alarm:" });
    for (const [key, alarmTime] of alarms) {
      if (alarmTime <= now) {
        const approvalId = key.replace("alarm:", "");
        await this.resolveDecision(approvalId, "timeout", { scheduleNext: false });
        await this.updateTimeoutStatus(approvalId);
      }
    }

    // Clean up expired decision entries to prevent unbounded storage growth
    const decisions = await this.ctx.storage.list<{ decision: DecisionStatus; expiresAt: number }>({
      prefix: "decision:",
    });
    const expiredKeys: string[] = [];
    for (const [key, entry] of decisions) {
      if (entry.expiresAt <= now) {
        expiredKeys.push(key);
      }
    }
    if (expiredKeys.length > 0) {
      await this.ctx.storage.delete(expiredKeys);
    }

    await this.scheduleNextAlarm();
  }

  private async waitForDecision(approvalId: string, timeoutMs: number): Promise<DecisionStatus> {
    const existing = await this.ctx.storage.get<{ decision: DecisionStatus; expiresAt: number }>(
      `decision:${approvalId}`,
    );
    if (existing) {
      return existing.decision;
    }

    const decisionPromise = new Promise<DecisionStatus>((resolve) => {
      const resolvers = this.pending.get(approvalId) ?? [];
      resolvers.push(resolve);
      this.pending.set(approvalId, resolvers);
    });

    const alarmTime = Date.now() + timeoutMs;
    await this.ctx.storage.put(`alarm:${approvalId}`, alarmTime);
    await this.scheduleNextAlarm();

    return decisionPromise;
  }

  private async resolveDecision(
    approvalId: string,
    decision: DecisionStatus,
    { scheduleNext }: { scheduleNext?: boolean } = {},
  ) {
    // Store decision with expiry time for cleanup
    const expiresAt = Date.now() + DECISION_TTL_MS;
    await this.ctx.storage.put(`decision:${approvalId}`, { decision, expiresAt });

    const resolvers = this.pending.get(approvalId);
    if (resolvers) {
      for (const resolver of resolvers) {
        resolver(decision);
      }
      this.pending.delete(approvalId);
    }

    await this.ctx.storage.delete(`alarm:${approvalId}`);
    if (scheduleNext !== false) {
      await this.scheduleNextAlarm();
    }
  }

  private async scheduleNextAlarm() {
    const alarms = await this.ctx.storage.list<number>({ prefix: "alarm:" });
    if (alarms.size === 0) {
      return;
    }

    const nextAlarm = Math.min(...alarms.values());
    await this.ctx.storage.setAlarm(nextAlarm);
  }

  private async updateTimeoutStatus(approvalId: string) {
    try {
      const db = getDbWithEnv(this.env);
      await db
        .update(schema.egressApproval)
        .set({
          status: "timeout" satisfies ApprovalStatus,
          decidedAt: new Date(),
        })
        .where(
          and(
            eq(schema.egressApproval.id, approvalId),
            eq(schema.egressApproval.status, "pending"),
          ),
        );
    } catch (error) {
      logger.error("Failed to update timeout status", {
        approvalId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
