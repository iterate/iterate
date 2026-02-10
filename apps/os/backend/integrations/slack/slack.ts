import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod/v4";
import { eq } from "drizzle-orm";
import { WebClient } from "@slack/web-api";
import { createMachineStub } from "@iterate-com/sandbox/providers/machine-stub";
import type { CloudflareEnv } from "../../../env.ts";
import { waitUntil } from "../../../env.ts";
import type { Variables } from "../../types.ts";
import * as schema from "../../db/schema.ts";
import { logger } from "../../tag-logger.ts";
import { encrypt } from "../../utils/encryption.ts";
import { trackWebhookEvent, linkExternalIdToGroups } from "../../lib/posthog.ts";
import { withSpan } from "../../utils/otel.ts";

import { pokeRunningMachinesToRefresh } from "../../utils/poke-machines.ts";
import { verifySlackSignature } from "./slack-utils.ts";

type CorrelationContext = {
  requestId: string;
  traceparent: string;
  slackEventId?: string;
};

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function isValidTraceparent(value: string | null | undefined): value is string {
  if (!value) return false;
  return /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/i.test(value);
}

function generateTraceparent(): string {
  return `00-${randomHex(16)}-${randomHex(8)}-01`;
}

function createCorrelationContext(params: {
  incomingRequestId: string | null;
  incomingTraceparent: string | null;
  slackEventId?: string;
}): CorrelationContext {
  const requestId =
    params.incomingRequestId?.trim() ||
    (params.slackEventId ? `slack-${params.slackEventId}` : `slack-${crypto.randomUUID()}`);

  return {
    requestId,
    traceparent: isValidTraceparent(params.incomingTraceparent)
      ? params.incomingTraceparent
      : generateTraceparent(),
    ...(params.slackEventId && { slackEventId: params.slackEventId }),
  };
}

/**
 * Build a provider-backed fetcher for forwarding to a machine daemon.
 */
async function buildMachineForwardFetcher(
  machine: typeof schema.machine.$inferSelect,
  env: CloudflareEnv,
): Promise<((input: string | Request | URL, init?: RequestInit) => Promise<Response>) | null> {
  const metadata = machine.metadata as Record<string, unknown> | null;

  try {
    const runtime = await createMachineStub({
      type: machine.type,
      env,
      externalId: machine.externalId,
      metadata: metadata ?? {},
    });
    return await runtime.getFetcher(3000);
  } catch (err) {
    logger.warn("[Slack Webhook] Failed to build forward fetcher", {
      machineId: machine.id,
      type: machine.type,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Forward a Slack webhook payload to a machine's daemon.
 * Extracted for testability and clarity.
 */
export async function forwardSlackWebhookToMachine(
  machine: typeof schema.machine.$inferSelect,
  payload: Record<string, unknown>,
  env: CloudflareEnv,
  correlation: CorrelationContext,
): Promise<{ success: boolean; error?: string }> {
  return withSpan(
    "slack.webhook.forward_to_machine",
    {
      attributes: {
        "messaging.system": "slack",
        "messaging.operation": "process",
        "slack.event_id": correlation.slackEventId ?? "unknown",
        "iterate.request_id": correlation.requestId,
        "machine.id": machine.id,
        "machine.type": machine.type,
      },
    },
    async (span) => {
      const targetPath = "/api/integrations/slack/webhook";
      const fetcher = await buildMachineForwardFetcher(machine, env);
      if (!fetcher) {
        span.setAttribute("forward.success", false);
        span.setAttribute("forward.error", "could_not_build_forward_fetcher");
        return { success: false, error: "Could not build forward fetcher" };
      }
      span.setAttribute("url.path", targetPath);

      try {
        const resp = await fetcher(targetPath, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-iterate-request-id": correlation.requestId,
            traceparent: correlation.traceparent,
            ...(correlation.slackEventId ? { "x-slack-event-id": correlation.slackEventId } : {}),
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(10000),
        });
        span.setAttribute("http.response.status_code", resp.status);

        if (!resp.ok) {
          span.setAttribute("forward.success", false);
          span.setAttribute("forward.error", `http_${resp.status}`);
          logger.error("[Slack Webhook] Forward failed", {
            machine,
            targetPath,
            status: resp.status,
            text: await resp.text(),
            correlation,
          });
          return { success: false, error: `HTTP ${resp.status}` };
        }

        span.setAttribute("forward.success", true);
        logger.info("[Slack Webhook] Forwarded to machine", {
          machineId: machine.id,
          targetPath,
          correlation,
        });
        return { success: true };
      } catch (err) {
        span.setAttribute("forward.success", false);
        span.setAttribute("forward.error", err instanceof Error ? err.message : String(err));
        logger.error("[Slack Webhook] Forward error", {
          err,
          machineId: machine.id,
          targetPath,
          correlation,
        });
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );
}

export const SLACK_BOT_SCOPES = [
  "channels:history",
  "channels:join",
  "channels:manage",
  "channels:read",
  "chat:write",
  "chat:write.public",
  "files:read",
  "files:write",
  "groups:history",
  "groups:read",
  "im:history",
  "im:read",
  "im:write",
  "mpim:history",
  "mpim:read",
  "reactions:read",
  "reactions:write",
  "users.profile:read",
  "users:read",
  "users:read.email",
  "assistant:write",
  "conversations.connect:write",
];

export type SlackOAuthStateData = {
  projectId: string;
  userId: string;
  callbackURL?: string;
};

/**
 * Revoke a Slack access token using auth.revoke API
 * Returns true if revocation succeeded or token was already invalid
 */
export async function revokeSlackToken(accessToken: string): Promise<boolean> {
  try {
    const response = await fetch("https://slack.com/api/auth.revoke", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });

    if (!response.ok) {
      logger.warn("Slack auth.revoke HTTP error", { status: response.status });
      return false;
    }

    const data = (await response.json()) as { ok: boolean; revoked?: boolean; error?: string };

    if (!data.ok) {
      // Token might already be invalid/revoked - that's fine
      if (data.error === "invalid_auth" || data.error === "token_revoked") {
        return true;
      }
      logger.warn("Slack auth.revoke API error", { error: data.error });
      return false;
    }

    return true;
  } catch (error) {
    logger.error("Failed to revoke Slack token", error);
    return false;
  }
}

export const slackApp = new Hono<{ Bindings: CloudflareEnv; Variables: Variables }>();

/**
 * Slack OAuth callback handler
 * Handles the redirect from Slack after the user authorizes the app
 */
slackApp.get(
  "/callback",
  zValidator(
    "query",
    z.object({
      state: z.string().optional(),
      code: z.string().optional(),
      error: z.string().optional(),
    }),
  ),
  async (c) => {
    if (!c.var.session) return c.json({ error: "Unauthorized" }, 401);

    const { state, code, error } = c.req.valid("query");

    // Handle OAuth denial/error from Slack
    if (error) {
      logger.warn("Slack OAuth error", { error });
      return c.redirect("/?error=slack_oauth_denied");
    }

    if (!state || !code) {
      logger.warn("Slack callback received without state or code");
      return c.redirect("/");
    }

    const verification = await c.var.db.query.verification.findFirst({
      where: eq(schema.verification.identifier, state),
    });

    await c.var.db.delete(schema.verification).where(eq(schema.verification.identifier, state));

    if (!verification || verification.expiresAt < new Date()) {
      return c.json({ error: "Invalid state or state has expired" }, 400);
    }

    const stateData = z
      .object({
        projectId: z.string(),
        userId: z.string(),
        callbackURL: z.string().optional(),
      })
      .parse(JSON.parse(verification.value));

    const { projectId, userId, callbackURL } = stateData;

    if (c.var.session.user.id !== userId) {
      logger.warn("Slack callback user mismatch", {
        sessionUserId: c.var.session.user.id,
        stateUserId: userId,
      });
      return c.json({ error: "User mismatch - please restart the Slack connection flow" }, 403);
    }

    // Use WebClient for proper OAuth v2 token exchange
    // arctic.Slack uses OpenID Connect which doesn't work with bot scopes
    const redirectUri = `${c.env.VITE_PUBLIC_URL}/api/integrations/slack/callback`;
    const slackClient = new WebClient();

    let tokens;
    try {
      tokens = await slackClient.oauth.v2.access({
        client_id: c.env.SLACK_CLIENT_ID,
        client_secret: c.env.SLACK_CLIENT_SECRET,
        code,
        redirect_uri: redirectUri,
      });
    } catch (error) {
      logger.error("Failed to exchange Slack authorization code", error);
      return c.json({ error: "Failed to validate authorization code" }, 400);
    }

    if (!tokens.ok || !tokens.access_token || !tokens.team?.id) {
      logger.error("Slack oauth.v2.access failed", tokens.error);
      return c.json({ error: "Failed to get tokens from Slack" }, 400);
    }

    const accessToken = tokens.access_token;
    const teamData = {
      id: tokens.team.id,
      name: tokens.team.name ?? "Unknown",
      domain: (tokens as { team: { domain?: string } }).team.domain ?? tokens.team.id,
    };

    const encryptedAccessToken = await encrypt(accessToken);

    let project;
    try {
      project = await c.var.db.transaction(async (tx) => {
        // Check if this project already has a Slack connection
        const existingProjectConnection = await tx.query.projectConnection.findFirst({
          where: (pc, { eq, and }) => and(eq(pc.projectId, projectId), eq(pc.provider, "slack")),
        });

        // Check if this Slack workspace is already connected to another project
        const existingWorkspaceConnection = await tx.query.projectConnection.findFirst({
          where: (pc, { eq, and }) => and(eq(pc.provider, "slack"), eq(pc.externalId, teamData.id)),
          with: { project: { with: { organization: true } } },
        });

        if (existingWorkspaceConnection && existingWorkspaceConnection.projectId !== projectId) {
          const existingProject = existingWorkspaceConnection.project;
          const existingOrg = existingProject?.organization;
          throw new Error(
            `workspace_already_connected:${JSON.stringify({
              teamId: teamData.id,
              teamName: teamData.name,
              existingProjectSlug: existingProject?.slug ?? "",
              existingProjectName: existingProject?.name ?? "",
              existingOrgSlug: existingOrg?.slug ?? "",
              existingOrgName: existingOrg?.name ?? "",
            })}`,
          );
        }

        if (existingProjectConnection) {
          await tx
            .update(schema.projectConnection)
            .set({
              externalId: teamData.id,
              providerData: {
                teamId: teamData.id,
                teamName: teamData.name,
                teamDomain: teamData.domain,
                encryptedAccessToken,
              },
            })
            .where(eq(schema.projectConnection.id, existingProjectConnection.id));
        } else {
          await tx.insert(schema.projectConnection).values({
            projectId,
            provider: "slack",
            externalId: teamData.id,
            scope: "project",
            userId,
            providerData: {
              teamId: teamData.id,
              teamName: teamData.name,
              teamDomain: teamData.domain,
              encryptedAccessToken,
            },
          });
        }

        // Upsert secret for egress proxy to use
        // This allows the magic string `getIterateSecret({secretKey: "slack.access_token"})` to resolve
        const projectInfo = await tx.query.project.findFirst({
          where: eq(schema.project.id, projectId),
        });

        if (projectInfo) {
          const existingSecret = await tx.query.secret.findFirst({
            where: (s, { and: whereAnd, eq: whereEq, isNull: whereIsNull }) =>
              whereAnd(
                whereEq(s.key, "slack.access_token"),
                whereEq(s.projectId, projectId),
                whereIsNull(s.userId), // Only match project-scoped secrets
              ),
          });

          const slackEgressRule = `$contains(url.hostname, 'slack.com')`;
          if (existingSecret) {
            await tx
              .update(schema.secret)
              .set({
                encryptedValue: encryptedAccessToken,
                lastSuccessAt: new Date(),
                egressProxyRule: slackEgressRule,
              })
              .where(eq(schema.secret.id, existingSecret.id));
          } else {
            await tx.insert(schema.secret).values({
              key: "slack.access_token",
              encryptedValue: encryptedAccessToken,
              organizationId: projectInfo.organizationId,
              projectId,
              egressProxyRule: slackEgressRule,
            });
          }
        }

        return tx.query.project.findFirst({
          where: eq(schema.project.id, projectId),
          with: {
            organization: true,
          },
        });
      });

      // Link Slack team to org/project in PostHog (after transaction commits)
      if (project) {
        linkExternalIdToGroups(c.env, {
          distinctId: `slack:${teamData.id}`,
          organizationId: project.organizationId,
          projectId,
        });
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("workspace_already_connected:")) {
        const conflictData = JSON.parse(
          error.message.replace("workspace_already_connected:", ""),
        ) as {
          teamId: string;
          teamName: string;
          existingProjectSlug: string;
          existingProjectName: string;
          existingOrgSlug: string;
          existingOrgName: string;
        };
        const params = new URLSearchParams({
          teamId: conflictData.teamId,
          teamName: conflictData.teamName,
          existingProjectSlug: conflictData.existingProjectSlug,
          existingProjectName: conflictData.existingProjectName,
          existingOrgSlug: conflictData.existingOrgSlug,
          existingOrgName: conflictData.existingOrgName,
          newProjectId: projectId,
        });
        return c.redirect(`/slack-conflict?${params.toString()}`);
      }
      throw error;
    }

    // Poke running machines to refresh their bootstrap data (they'll pull the new Slack token)
    waitUntil(
      pokeRunningMachinesToRefresh(c.var.db, projectId, c.env).catch((err) => {
        logger.error("[Slack OAuth] Failed to poke machines for refresh", err);
      }),
    );

    const redirectPath =
      callbackURL ||
      (project ? `/orgs/${project.organization.slug}/projects/${project.slug}/connectors` : "/");
    return c.redirect(redirectPath);
  },
);

/**
 * Slack webhook handler
 * - Verifies Slack signature synchronously
 * - Handles url_verification challenge synchronously
 * - Processes events in background via waitUntil for Slack compliance
 * - Deduplicates events via slack_event_id
 */
slackApp.post("/webhook", async (c) => {
  // Signature verification - KEEP SYNCHRONOUS
  const body = await c.req.text();
  const isValid = await verifySlackSignature(
    c.env.SLACK_SIGNING_SECRET,
    c.req.header("x-slack-signature") ?? null,
    c.req.header("x-slack-request-timestamp") ?? null,
    body,
  );
  if (!isValid) {
    logger.debug("[Slack Webhook] Invalid signature");
    return c.text("Invalid signature", 200);
  }

  // Parse - KEEP SYNCHRONOUS
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body);
  } catch {
    return c.text("Invalid JSON", 400);
  }

  // Extract team ID for tracking and processing
  const teamId =
    (payload.team_id as string) ||
    ((payload.team as Record<string, unknown>)?.id as string) ||
    ((payload.event as Record<string, unknown>)?.team as string);

  // URL verification - return immediately
  if (payload.type === "url_verification") {
    return c.json({ challenge: payload.challenge });
  }
  // Extract event_id for dedup
  const slackEventId = payload.event_id as string;
  const correlation = createCorrelationContext({
    incomingRequestId: c.req.header("x-iterate-request-id") ?? null,
    incomingTraceparent: c.req.header("traceparent") ?? null,
    slackEventId,
  });

  // Log full payload for debugging
  logger.debug("[Slack Webhook] Received", {
    payload,
    requestId: correlation.requestId,
    traceparent: correlation.traceparent,
  });

  // Get references before returning (needed in background)
  const db = c.var.db;
  const env = c.env;

  // RETURN IMMEDIATELY - process in background for Slack compliance
  waitUntil(
    withSpan(
      "slack.webhook.process",
      {
        attributes: {
          "messaging.system": "slack",
          "messaging.operation": "process",
          "iterate.request_id": correlation.requestId,
          "slack.event_id": slackEventId ?? "unknown",
          "slack.team_id": teamId ?? "unknown",
        },
      },
      async (span) => {
        try {
          if (!teamId) {
            logger.warn("[Slack Webhook] No team_id in payload", { correlation });
            span.setAttribute("process.result", "missing_team_id");
            // Still track the event, just without groups
            trackWebhookEvent(env, {
              distinctId: "slack:unknown",
              event: "slack:webhook_received",
              properties: payload,
            });
            return;
          }

          // TODO: move enrichment out of webhook path (tasks/machine-metrics-pipeline.md).
          logger.debug("[Slack Webhook] Looking up connection", { teamId, correlation });
          // Find connection and the single active machine for its project
          const connection = await db.query.projectConnection.findFirst({
            where: (pc, { eq, and }) => and(eq(pc.provider, "slack"), eq(pc.externalId, teamId)),
            with: {
              project: {
                with: {
                  machines: {
                    where: (m, { eq }) => eq(m.state, "active"),
                    limit: 1,
                  },
                },
              },
            },
          });

          // Track webhook in PostHog with group association
          trackWebhookEvent(env, {
            distinctId: `slack:${teamId}`,
            event: "slack:webhook_received",
            properties: payload,
            groups: connection?.project
              ? {
                  organization: connection.project.organizationId,
                  project: connection.projectId,
                }
              : undefined,
          });

          // Dedup check using external_id (Slack's event_id)
          if (slackEventId) {
            const existing = await db.query.event.findFirst({
              where: (e, { eq }) => eq(e.externalId, slackEventId),
            });
            if (existing) {
              logger.debug("[Slack Webhook] Duplicate, skipping", { slackEventId, correlation });
              span.setAttribute("process.result", "duplicate_event");
              return;
            }
          }

          const projectId = connection?.projectId;
          if (!projectId) {
            logger.warn("[Slack Webhook] No project for team", { teamId, correlation });
            span.setAttribute("process.result", "missing_project_connection");
            return;
          }

          // Get the single active machine for this project
          const targetMachine = connection.project?.machines[0] ?? null;

          // Forward to machine if available
          if (targetMachine) {
            logger.debug("[Slack Webhook] Forwarding to machine", {
              machineId: targetMachine.id,
              correlation,
            });
            span.setAttribute("machine.id", targetMachine.id);
            await forwardSlackWebhookToMachine(targetMachine, payload, env, correlation);
          }

          // Save event with type slack:webhook-received, detailed info in payload
          await db.insert(schema.event).values({
            type: "slack:webhook-received",
            payload: payload,
            projectId,
            externalId: slackEventId,
          });
          span.setAttribute("process.result", "ok");
        } catch (err) {
          logger.error("[Slack Webhook] Background error", { err, correlation });
          span.setAttribute("process.result", "error");
          throw err;
        }
      },
    ),
  );

  return c.text("ok");
});

/**
 * Slack interactive endpoint (for future use)
 * Handles interactive components like buttons, menus, etc.
 */
slackApp.post("/interactive", async (c) => {
  const body = await c.req.text();

  // Verify Slack signature
  const isValid = await verifySlackSignature(
    c.env.SLACK_SIGNING_SECRET,
    c.req.header("x-slack-signature") ?? null,
    c.req.header("x-slack-request-timestamp") ?? null,
    body,
  );

  if (!isValid) {
    return c.json({ error: "Invalid signature" }, 401);
  }

  // Parse the payload (interactive payloads are URL-encoded with a payload field)
  const formData = new URLSearchParams(body);
  const payloadStr = formData.get("payload");

  if (!payloadStr) {
    return c.json({ error: "Missing payload" }, 400);
  }

  try {
    JSON.parse(payloadStr);
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  return c.json({ ok: true });
});

/**
 * Slack slash commands endpoint (for future use)
 */
slackApp.post("/commands", async (c) => {
  const body = await c.req.text();

  // Verify Slack signature
  const isValid = await verifySlackSignature(
    c.env.SLACK_SIGNING_SECRET,
    c.req.header("x-slack-signature") ?? null,
    c.req.header("x-slack-request-timestamp") ?? null,
    body,
  );

  if (!isValid) {
    return c.json({ error: "Invalid signature" }, 401);
  }

  return c.json({
    response_type: "ephemeral",
    text: "Command received! This feature is coming soon.",
  });
});
