import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { CloudflareEnv } from "../../env.ts";
import type { Variables } from "../types.ts";
import * as schema from "../db/schema.ts";
import { logger } from "../tag-logger.ts";
import { pokeAllMachinesToPullIterateRepo } from "../utils/poke-machines.ts";

export const serviceApp = new Hono<{ Bindings: CloudflareEnv; Variables: Variables }>();

/**
 * Middleware to verify service auth token.
 * Expects Authorization: Bearer <SERVICE_AUTH_TOKEN>
 */
serviceApp.use("*", async (c, next) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Missing authorization header" }, 401);
  }

  const token = authHeader.slice(7);
  if (token !== c.env.SERVICE_AUTH_TOKEN) {
    return c.json({ error: "Invalid service token" }, 403);
  }

  return next();
});

/**
 * POST /api/service/poke-machines-pull
 *
 * Pokes all active machines to pull the iterate repo.
 * Called by GitHub Actions after a successful prod deploy.
 */
serviceApp.post("/poke-machines-pull", async (c) => {
  const db = c.var.db;

  // Find all active machines
  const activeMachines = await db.query.machine.findMany({
    where: eq(schema.machine.state, "active"),
  });

  if (activeMachines.length === 0) {
    logger.info("[service] No active machines to poke");
    return c.json({ success: true, machineCount: 0, message: "No active machines" });
  }

  logger.info("[service] Poking machines to pull iterate repo", {
    machineCount: activeMachines.length,
  });

  // Poke all machines in parallel
  const results = await pokeAllMachinesToPullIterateRepo(db, activeMachines, c.env);

  const successCount = results.filter((r) => r.success).length;
  const failedCount = results.filter((r) => !r.success).length;

  return c.json({
    success: true,
    machineCount: activeMachines.length,
    successCount,
    failedCount,
  });
});
