import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import type { CloudflareEnv } from "../../../env";
import type { Variables } from "../../worker";
import * as schema from "../../db/schema.ts";
import { verifySignedUrl, BuildCallbackPayload } from "../../utils/url-signing.ts";
import { invalidateOrganizationQueries } from "../../utils/websocket-utils.ts";

export const buildCallbackApp = new Hono<{ Bindings: CloudflareEnv; Variables: Variables }>();

buildCallbackApp.post("/callback", zValidator("json", BuildCallbackPayload), async (c) => {
  // Verify the signed URL
  const url = c.req.url;
  const isValid = await verifySignedUrl(url, c.env.EXPIRING_URLS_SIGNING_KEY);

  if (!isValid) {
    console.error("Invalid or expired callback URL");
    return c.json({ error: "Invalid or expired callback URL" }, 401);
  }

  const { buildId, estateId, success, stdout, stderr, exitCode } = c.req.valid("json");

  try {
    // Update the build record
    const buildStatus = success ? "complete" : "failed";
    const output = {
      stdout: stdout || "",
      stderr: stderr || "",
      exitCode,
    };

    await c.var.db
      .update(schema.builds)
      .set({
        status: buildStatus,
        completedAt: new Date(),
        output,
      })
      .where(eq(schema.builds.id, buildId));

    // Get the estate with organization for WebSocket invalidation
    const estateWithOrg = await c.var.db.query.estate.findFirst({
      where: eq(schema.estate.id, estateId),
      with: {
        organization: true,
      },
    });

    // Invalidate organization queries to show the completed/failed build
    if (estateWithOrg?.organization) {
      await invalidateOrganizationQueries(c.env, estateWithOrg.organization.id, {
        type: "INVALIDATE",
        invalidateInfo: {
          type: "TRPC_QUERY",
          paths: ["estate.getBuilds"],
        },
      });
    }

    // Store the configuration in the iterateConfig table if successful
    if (success && stdout) {
      try {
        // Parse the output to extract the configuration
        const configData = JSON.parse(stdout);

        // Upsert the config - always overwrite if it exists
        await c.var.db
          .insert(schema.iterateConfig)
          .values({
            config: configData,
            estateId,
          })
          .onConflictDoUpdate({
            target: schema.iterateConfig.estateId,
            set: {
              config: configData,
            },
          });
      } catch (parseError) {
        console.error("Failed to parse configuration output:", parseError);
        console.error("Stdout that failed to parse:", stdout);
        // The build succeeded but we couldn't parse the config
        // This is logged but not treated as a build failure
      }
    }

    return c.json({
      message: "Build callback processed",
      buildId,
      status: buildStatus,
    });
  } catch (error) {
    return c.json(
      {
        error: "Internal server error",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});
