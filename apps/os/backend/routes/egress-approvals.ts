import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { waitUntil, type CloudflareEnv } from "../../env.ts";
import type { Variables } from "../types.ts";
import * as schema from "../db/schema.ts";
import type { ApprovalStatus, EgressApproval } from "../egress-proxy/types.ts";
import type { DB } from "../db/client.ts";
import { broadcastInvalidation } from "../utils/query-invalidation.ts";
import { logger } from "../tag-logger.ts";

export const egressApprovalsApp = new Hono<{ Bindings: CloudflareEnv; Variables: Variables }>();

egressApprovalsApp.get("/projects/:projectId/approvals", async (c) => {
  const session = c.var.session;
  if (!session) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const { projectId } = c.req.param();
  const statusParam = c.req.query("status");
  const status = parseApprovalStatus(statusParam);
  if (status === "invalid") {
    return c.json({ error: "Invalid status" }, 400);
  }

  const db = c.var.db;
  const access = await requireProjectAccess(
    db,
    projectId,
    session.user.id,
    session.user.role === "admin",
  );
  if (!access) {
    return c.json({ error: "Not found or forbidden" }, 404);
  }

  const conditions = [eq(schema.egressApproval.projectId, projectId)];
  if (status) {
    conditions.push(eq(schema.egressApproval.status, status));
  }

  const approvals = await db
    .select()
    .from(schema.egressApproval)
    .where(conditions.length === 1 ? conditions[0] : and(...conditions))
    .orderBy(desc(schema.egressApproval.createdAt))
    .limit(100);

  return c.json({ approvals });
});

egressApprovalsApp.get("/projects/:projectId/approvals/:id", async (c) => {
  const session = c.var.session;
  if (!session) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const { projectId, id } = c.req.param();
  const db = c.var.db;
  const access = await requireProjectAccess(
    db,
    projectId,
    session.user.id,
    session.user.role === "admin",
  );
  if (!access) {
    return c.json({ error: "Not found or forbidden" }, 404);
  }

  const approval = await db.query.egressApproval.findFirst({
    where: and(eq(schema.egressApproval.id, id), eq(schema.egressApproval.projectId, projectId)),
  });

  if (!approval) {
    return c.json({ error: "Approval not found" }, 404);
  }

  return c.json({ approval });
});

egressApprovalsApp.post("/projects/:projectId/approvals/:id/approve", async (c) => {
  const session = c.var.session;
  if (!session) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const { projectId, id } = c.req.param();
  const db = c.var.db;
  const access = await requireProjectAccess(
    db,
    projectId,
    session.user.id,
    session.user.role === "admin",
  );
  if (!access) {
    return c.json({ error: "Not found or forbidden" }, 404);
  }

  // Notify DO first to avoid state where DB shows approved but DO never got notified
  const stub = c.env.APPROVAL_COORDINATOR.get(c.env.APPROVAL_COORDINATOR.idFromName(projectId));
  const doResponse = await stub.fetch(`https://approval-coordinator/decide/${id}`, {
    method: "POST",
    body: "approved",
  });
  if (!doResponse.ok) {
    return c.json({ error: "Failed to notify approval coordinator" }, 500);
  }

  const updated = await updateApprovalDecision(db, projectId, id, "approved", session.user.id);
  if (!updated) {
    // DO was notified but DB update failed - the waiting request will still succeed
    // Log this for monitoring but don't fail the user action
    logger.error("DB update failed after DO notification", {
      project: { id: projectId },
      approvalId: id,
    });
  }

  waitUntil(broadcastInvalidation(c.env));

  return c.json({ success: true, status: "approved" });
});

egressApprovalsApp.post("/projects/:projectId/approvals/:id/reject", async (c) => {
  const session = c.var.session;
  if (!session) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const { projectId, id } = c.req.param();
  const db = c.var.db;
  const access = await requireProjectAccess(
    db,
    projectId,
    session.user.id,
    session.user.role === "admin",
  );
  if (!access) {
    return c.json({ error: "Not found or forbidden" }, 404);
  }

  // Notify DO first to avoid state where DB shows rejected but DO never got notified
  const stub = c.env.APPROVAL_COORDINATOR.get(c.env.APPROVAL_COORDINATOR.idFromName(projectId));
  const doResponse = await stub.fetch(`https://approval-coordinator/decide/${id}`, {
    method: "POST",
    body: "rejected",
  });
  if (!doResponse.ok) {
    return c.json({ error: "Failed to notify approval coordinator" }, 500);
  }

  const updated = await updateApprovalDecision(db, projectId, id, "rejected", session.user.id);
  if (!updated) {
    // DO was notified but DB update failed - the waiting request will still get rejected
    // Log this for monitoring but don't fail the user action
    logger.error("DB update failed after DO notification", {
      project: { id: projectId },
      approvalId: id,
    });
  }

  waitUntil(broadcastInvalidation(c.env));

  return c.json({ success: true, status: "rejected" });
});

function parseApprovalStatus(status: string | undefined): ApprovalStatus | "invalid" | null {
  if (!status || status === "all") return null;
  if (
    status === "pending" ||
    status === "approved" ||
    status === "rejected" ||
    status === "timeout"
  ) {
    return status;
  }
  return "invalid";
}

async function requireProjectAccess(
  db: DB,
  projectId: string,
  userId: string,
  isSystemAdmin: boolean,
): Promise<boolean> {
  const rows = await db
    .select({
      membershipId: schema.organizationUserMembership.id,
    })
    .from(schema.project)
    .innerJoin(schema.organization, eq(schema.project.organizationId, schema.organization.id))
    .leftJoin(
      schema.organizationUserMembership,
      and(
        eq(schema.organizationUserMembership.organizationId, schema.organization.id),
        eq(schema.organizationUserMembership.userId, userId),
      ),
    )
    .where(eq(schema.project.id, projectId))
    .limit(1);

  const row = rows[0];
  if (!row) return false;
  if (!row.membershipId && !isSystemAdmin) return false;
  return true;
}

async function updateApprovalDecision(
  db: DB,
  projectId: string,
  approvalId: string,
  status: ApprovalStatus,
  decidedBy: string,
): Promise<EgressApproval | null> {
  const [updated] = await db
    .update(schema.egressApproval)
    .set({
      status,
      decidedAt: new Date(),
      decidedBy,
    })
    .where(
      and(
        eq(schema.egressApproval.id, approvalId),
        eq(schema.egressApproval.projectId, projectId),
        eq(schema.egressApproval.status, "pending"),
      ),
    )
    .returning();

  return updated ?? null;
}
