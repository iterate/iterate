import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod/v4";
import { eq } from "drizzle-orm";
import { WebClient } from "@slack/web-api";
import type { CloudflareEnv } from "../../../env.ts";
import { waitUntil } from "../../../env.ts";
import type { Variables } from "../../worker.ts";
import * as schema from "../../db/schema.ts";
import { logger } from "../../tag-logger.ts";
import { encrypt } from "../../utils/encryption.ts";
import { getDaemonById } from "../../daemons.ts";
import { pokeRunningMachinesToRefresh } from "../../utils/poke-machines.ts";
import { verifySlackSignature } from "./slack-utils.ts";

/**
 * Check if a host is an internal/blocked address (SSRF protection).
 * Blocks: localhost, private IPs (10.x, 172.16-31.x, 192.168.x), link-local, cloud metadata.
 */
function isBlockedHost(host: string): boolean {
  const h = host.toLowerCase().trim();

  // Block localhost
  if (h === "localhost" || h.startsWith("127.")) return true;

  // Block cloud metadata endpoints
  if (h === "169.254.169.254" || h === "metadata.google.internal") return true;

  // Block private IPs
  const ip = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ip) {
    const [, a, b] = ip.map(Number);
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local)
  }

  return false;
}

/**
 * Build URL to forward webhooks to a machine's daemon.
 * Supports all machine types: daytona, local-docker, local.
 */
function buildMachineForwardUrl(
  machine: typeof schema.machine.$inferSelect,
  path: string,
): string | null {
  const metadata = machine.metadata as Record<string, unknown> | null;

  switch (machine.type) {
    case "local": {
      // Local machine: forward to configured host:port
      const host = metadata?.host as string | undefined;
      // Support both new format (ports map) and legacy (single port)
      const ports = metadata?.ports as Record<string, number> | undefined;
      const port = ports?.["iterate-daemon"] ?? (metadata?.port as number | undefined);
      if (!host || !port) {
        logger.warn("[Slack Webhook] Local machine missing host/port config", {
          machineId: machine.id,
        });
        return null;
      }
      // SSRF protection: block internal IPs
      if (isBlockedHost(host)) {
        logger.warn("[Slack Webhook] Blocked internal IP", {
          host,
          machineId: machine.id,
        });
        return null;
      }
      return `http://${host}:${port}${path}`;
    }

    case "local-docker": {
      // Local docker: forward to localhost with mapped port
      // Support both new format (ports map) and legacy (single port)
      const ports = metadata?.ports as Record<string, number> | undefined;
      const port = ports?.["iterate-daemon"] ?? (metadata?.port as number | undefined);
      if (!port) {
        logger.warn("[Slack Webhook] Local docker machine missing port", {
          machineId: machine.id,
        });
        return null;
      }
      return `http://localhost:${port}${path}`;
    }

    case "daytona":
      // Daytona: use external proxy URL
      if (!machine.externalId) {
        logger.warn("[Slack Webhook] Daytona machine missing externalId", {
          machineId: machine.id,
        });
        return null;
      }
      return `https://${getDaemonById("iterate-daemon")?.internalPort}-${machine.externalId}.proxy.daytona.works${path}`;

    default:
      logger.warn("[Slack Webhook] Unknown machine type for forwarding", {
        machineId: machine.id,
        type: machine.type,
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
): Promise<{ success: boolean; error?: string }> {
  const targetUrl = buildMachineForwardUrl(machine, "/api/integrations/slack/webhook");
  if (!targetUrl) {
    return { success: false, error: "Could not build forward URL" };
  }
  try {
    const resp = await fetch(targetUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) {
      logger.error("[Slack Webhook] Forward failed", {
        machine,
        targetUrl,
        status: resp.status,
        text: await resp.text(),
      });
      return { success: false, error: `HTTP ${resp.status}` };
    }
    return { success: true };
  } catch (err) {
    logger.error("[Slack Webhook] Forward error", err);
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
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

        return tx.query.project.findFirst({
          where: eq(schema.project.id, projectId),
          with: {
            organization: true,
          },
        });
      });
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

    // Encode slugs to handle legacy data with periods or special chars
    const redirectPath =
      callbackURL ||
      (project
        ? `/orgs/${encodeURIComponent(project.organization.slug)}/projects/${encodeURIComponent(project.slug)}/connectors`
        : "/");
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

  // URL verification - return immediately
  if (payload.type === "url_verification") {
    return c.json({ challenge: payload.challenge });
  }

  // Extract event_id for dedup
  const slackEventId = payload.event_id as string | undefined;
  const teamId =
    (payload.team_id as string) ||
    ((payload.team as Record<string, unknown>)?.id as string) ||
    ((payload.event as Record<string, unknown>)?.team as string);

  // Log full payload for debugging
  logger.debug("[Slack Webhook] Received", { payload });

  // Get db reference before returning (needed in background)
  const db = c.var.db;

  // RETURN IMMEDIATELY - process in background for Slack compliance
  waitUntil(
    (async () => {
      try {
        if (!teamId) {
          logger.warn("[Slack Webhook] No team_id in payload");
          return;
        }

        // Dedup check using external_id (Slack's event_id)
        if (slackEventId) {
          const existing = await db.query.event.findFirst({
            where: (e, { eq }) => eq(e.externalId, slackEventId),
          });
          if (existing) {
            logger.debug("[Slack Webhook] Duplicate, skipping", { slackEventId });
            return;
          }
        }

        logger.debug("[Slack Webhook] Looking up connection", { teamId });
        // Find connection and the single active machine for its project
        const connection = await db.query.projectConnection.findFirst({
          where: (pc, { eq, and }) => and(eq(pc.provider, "slack"), eq(pc.externalId, teamId)),
          with: {
            project: {
              with: {
                machines: {
                  where: (m, { eq }) => eq(m.state, "started"),
                  limit: 1,
                },
              },
            },
          },
        });

        const projectId = connection?.projectId;
        if (!projectId) {
          logger.warn("[Slack Webhook] No project for team", { teamId });
          return;
        }

        // Get the single active machine for this project
        const targetMachine = connection.project?.machines[0] ?? null;

        // Forward to machine if available
        if (targetMachine) {
          logger.debug("[Slack Webhook] Forwarding to machine", { machineId: targetMachine.id });
          await forwardSlackWebhookToMachine(targetMachine, payload);
        }

        // Save event with type slack:webhook-received, detailed info in payload
        await db.insert(schema.event).values({
          type: "slack:webhook-received",
          payload: payload,
          projectId,
          externalId: slackEventId,
        });
      } catch (err) {
        logger.error("[Slack Webhook] Background error", err);
      }
    })(),
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
