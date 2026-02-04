import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { CloudflareEnv } from "../../../env.ts";
import type { Variables } from "../../types.ts";
import * as schema from "../../db/schema.ts";
import { logger } from "../../tag-logger.ts";
import { waitUntil } from "../../../env.ts";
import { createMachineForProject } from "../../services/machine-creation.ts";

export const githubWebhookApp = new Hono<{ Bindings: CloudflareEnv; Variables: Variables }>();

/**
 * Verify GitHub webhook signature using HMAC SHA-256.
 * GitHub sends the signature in the `x-hub-signature-256` header.
 */
async function verifyGitHubSignature(
  secret: string,
  signature: string | null,
  body: string,
): Promise<boolean> {
  if (!signature) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signatureBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  const expectedSignature =
    "sha256=" +
    Array.from(new Uint8Array(signatureBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

  // Timing-safe comparison
  if (signature.length !== expectedSignature.length) return false;
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
}

// GitHub workflow_run event payload (relevant fields)
type WorkflowRunPayload = {
  action: string;
  workflow_run: {
    id: number;
    name: string;
    head_branch: string;
    head_sha: string;
    path: string;
    conclusion: string | null;
    repository: {
      full_name: string;
    };
  };
  repository: {
    full_name: string;
  };
};

githubWebhookApp.post("/", async (c) => {
  const body = await c.req.text();
  const signature = c.req.header("x-hub-signature-256");
  const event = c.req.header("x-github-event");
  const deliveryId = c.req.header("x-github-delivery");

  // Verify signature
  const isValid = await verifyGitHubSignature(c.env.GITHUB_WEBHOOK_SECRET, signature ?? null, body);
  if (!isValid) {
    logger.warn("[GitHub Webhook] Invalid signature");
    return c.json({ error: "Invalid signature" }, 401);
  }

  // Only handle workflow_run events
  if (event !== "workflow_run") {
    logger.debug("[GitHub Webhook] Ignoring event", { event });
    return c.json({ ignored: true, reason: "not workflow_run" });
  }

  const payload = JSON.parse(body) as WorkflowRunPayload;
  const { action, workflow_run } = payload;

  // Only handle completed workflows
  if (action !== "completed") {
    logger.debug("[GitHub Webhook] Ignoring action", { action });
    return c.json({ ignored: true, reason: "not completed" });
  }

  // Only handle successful workflows
  if (workflow_run.conclusion !== "success") {
    logger.debug("[GitHub Webhook] Ignoring non-success", { conclusion: workflow_run.conclusion });
    return c.json({ ignored: true, reason: "not success" });
  }

  // Only handle main branch
  if (workflow_run.head_branch !== "main") {
    logger.debug("[GitHub Webhook] Ignoring branch", { branch: workflow_run.head_branch });
    return c.json({ ignored: true, reason: "not main branch" });
  }

  // Only handle ci.yml workflow
  if (!workflow_run.path.endsWith("ci.yml")) {
    logger.debug("[GitHub Webhook] Ignoring workflow", { path: workflow_run.path });
    return c.json({ ignored: true, reason: "not ci.yml" });
  }

  // Only handle iterate/iterate repo
  if (workflow_run.repository.full_name !== "iterate/iterate") {
    logger.debug("[GitHub Webhook] Ignoring repo", { repo: workflow_run.repository.full_name });
    return c.json({ ignored: true, reason: "not iterate/iterate" });
  }

  const db = c.var.db;
  const env = c.env;
  const workflowRunId = workflow_run.id.toString();
  const headSha = workflow_run.head_sha;

  // Return immediately - process in background
  waitUntil(
    (async () => {
      try {
        // Dedup check using workflow_run.id as externalId
        const existing = await db.query.event.findFirst({
          where: (e, { eq: whereEq }) => whereEq(e.externalId, workflowRunId),
        });
        if (existing) {
          logger.debug("[GitHub Webhook] Duplicate, skipping", { workflowRunId });
          return;
        }

        logger.info("[GitHub Webhook] Processing CI completion", {
          workflowRunId,
          headSha,
          deliveryId,
        });

        // Get all projects with active machines
        const projectsWithActiveMachines = await db.query.project.findMany({
          with: {
            organization: true,
            machines: {
              where: (m, { eq: whereEq }) => whereEq(m.state, "active"),
              limit: 1,
            },
          },
        });

        const projectsToUpdate = projectsWithActiveMachines.filter((p) => p.machines.length > 0);

        logger.info("[GitHub Webhook] Found projects to update", {
          total: projectsWithActiveMachines.length,
          withActiveMachines: projectsToUpdate.length,
        });

        // Create new machines for each project
        let successCount = 0;
        let errorCount = 0;

        for (const project of projectsToUpdate) {
          try {
            const activeMachine = project.machines[0];
            const machineName = `ci-${headSha.slice(0, 7)}`;

            await createMachineForProject({
              db,
              env,
              projectId: project.id,
              organizationId: project.organizationId,
              organizationSlug: project.organization.slug,
              projectSlug: project.slug,
              name: machineName,
              type: activeMachine.type,
              metadata: (activeMachine.metadata as Record<string, unknown>) ?? {},
            });

            logger.info("[GitHub Webhook] Created machine", {
              projectId: project.id,
              machineName,
            });
            successCount++;
          } catch (err) {
            logger.error("[GitHub Webhook] Failed to create machine", {
              projectId: project.id,
              error: err instanceof Error ? err.message : String(err),
            });
            errorCount++;
          }
        }

        // Save event for deduplication
        await db.insert(schema.event).values({
          type: "github:ci-completed",
          payload: {
            workflow_run_id: workflow_run.id,
            head_sha: headSha,
            head_branch: workflow_run.head_branch,
            delivery_id: deliveryId,
            machines_created: successCount,
            machines_failed: errorCount,
          },
          externalId: workflowRunId,
        });

        logger.info("[GitHub Webhook] Completed machine recreation", {
          successCount,
          errorCount,
        });
      } catch (err) {
        logger.error("[GitHub Webhook] Background error", err);
      }
    })(),
  );

  return c.json({ received: true, workflowRunId });
});
