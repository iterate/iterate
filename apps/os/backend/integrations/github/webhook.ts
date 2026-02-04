import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod/v4";
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

// Zod schema for GitHub workflow_run event payload
const WorkflowRunPayload = z.object({
  action: z.string(),
  workflow_run: z.object({
    id: z.number(),
    name: z.string(),
    head_branch: z.string(),
    head_sha: z.string(),
    path: z.string(),
    conclusion: z.string().nullable(),
    repository: z.object({
      full_name: z.string(),
    }),
  }),
  repository: z.object({
    full_name: z.string(),
  }),
});

// Schema to validate this is the CI completion event we care about
const CICompletionEvent = z.object({
  action: z.literal("completed"),
  workflow_run: z.object({
    id: z.number(),
    head_branch: z.literal("main"),
    head_sha: z.string(),
    path: z.string().endsWith("ci.yml"),
    conclusion: z.literal("success"),
    repository: z.object({
      full_name: z.literal("iterate/iterate"),
    }),
  }),
});

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

  // Parse and validate payload structure
  const parseResult = WorkflowRunPayload.safeParse(JSON.parse(body));
  if (!parseResult.success) {
    logger.warn("[GitHub Webhook] Invalid payload", { error: z.prettifyError(parseResult.error) });
    return c.json({ ignored: true, reason: z.prettifyError(parseResult.error) });
  }

  const payload = parseResult.data;

  // Validate this is the specific CI completion event we care about
  const ciEventResult = CICompletionEvent.safeParse(payload);
  if (!ciEventResult.success) {
    logger.debug("[GitHub Webhook] Not a matching CI event", {
      error: z.prettifyError(ciEventResult.error),
    });
    return c.json({ ignored: true, reason: z.prettifyError(ciEventResult.error) });
  }

  const { workflow_run } = payload;
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
