import { homedir } from "node:os";
import { z } from "zod/v4";
import { TRPCError } from "@trpc/server";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/index.ts";
import * as schema from "../db/schema.ts";
import type { Agent, AgentRoute } from "../db/schema.ts";
import { IterateEvent } from "../types/events.ts";
import { validateAgentPath } from "../utils/agent-path.ts";
import { getAgentWorkingDirectory } from "../utils/agent-working-directory.ts";
import { createTRPCRouter, publicProcedure } from "./init.ts";
import { platformRouter, getCustomerRepoPath } from "./platform.ts";

/** Serialized agent with ISO date strings instead of Date objects */
type SerializedAgentRoute = Omit<AgentRoute, "createdAt" | "updatedAt"> & {
  createdAt: string | null;
  updatedAt: string | null;
};

type SerializedAgent = Omit<Agent, "createdAt" | "updatedAt" | "archivedAt"> & {
  createdAt: string | null;
  updatedAt: string | null;
  archivedAt: string | null;
  activeRoute: SerializedAgentRoute | null;
};

function serializeAgentRoute(route: AgentRoute): SerializedAgentRoute {
  return {
    ...route,
    createdAt: route.createdAt?.toISOString() ?? null,
    updatedAt: route.updatedAt?.toISOString() ?? null,
  };
}

function serializeAgent(agent: Agent, route: AgentRoute | null): SerializedAgent {
  return {
    ...agent,
    createdAt: agent.createdAt?.toISOString() ?? null,
    updatedAt: agent.updatedAt?.toISOString() ?? null,
    archivedAt: agent.archivedAt?.toISOString() ?? null,
    activeRoute: route ? serializeAgentRoute(route) : null,
  };
}

/**
 * POST an `iterate:agent-updated` event to all registered callback URLs for
 * this agent. The payload is the same SerializedAgent you'd get from getAgent.
 * This is currently the only event type. In the future, other iterate-level
 * or raw OpenCode events may be delivered on this same callback channel.
 */
async function notifyAgentChange(agentPath: string, agent: SerializedAgent): Promise<void> {
  const subscriptions = await db
    .select()
    .from(schema.agentSubscriptions)
    .where(eq(schema.agentSubscriptions.agentPath, agentPath));

  const event = { type: "iterate:agent-updated" as const, payload: agent };

  for (const subscription of subscriptions) {
    void fetch(subscription.callbackUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    }).catch((error) => {
      console.error("[agent-change] callback failed", {
        agentPath,
        callbackUrl: subscription.callbackUrl,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}

export const trpcRouter = createTRPCRouter({
  platform: platformRouter,
  hello: publicProcedure.query(() => ({ message: "Hello from tRPC!" })),

  getServerCwd: publicProcedure.query(async () => {
    return {
      cwd: process.cwd(),
      homeDir: homedir(),
      customerRepoPath: await getCustomerRepoPath(),
    };
  }),

  // ============ Agent CRUD ============

  listAgents: publicProcedure.query(async (): Promise<SerializedAgent[]> => {
    const rows = await db
      .select({ agent: schema.agents, route: schema.agentRoutes })
      .from(schema.agents)
      .leftJoin(
        schema.agentRoutes,
        and(
          eq(schema.agentRoutes.agentPath, schema.agents.path),
          eq(schema.agentRoutes.active, true),
        ),
      )
      .where(isNull(schema.agents.archivedAt))
      .orderBy(schema.agents.createdAt);

    return rows.map(({ agent, route }) => serializeAgent(agent, route ?? null));
  }),

  getAgent: publicProcedure
    .input(z.object({ path: z.string() }))
    .query(async ({ input }): Promise<SerializedAgent | null> => {
      const rows = await db
        .select({ agent: schema.agents, route: schema.agentRoutes })
        .from(schema.agents)
        .leftJoin(
          schema.agentRoutes,
          and(
            eq(schema.agentRoutes.agentPath, schema.agents.path),
            eq(schema.agentRoutes.active, true),
          ),
        )
        .where(and(eq(schema.agents.path, input.path), isNull(schema.agents.archivedAt)))
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      return serializeAgent(row.agent, row.route ?? null);
    }),

  archiveAgent: publicProcedure
    .input(z.object({ path: z.string() }))
    .mutation(async ({ input }): Promise<{ success: boolean }> => {
      const [agent] = await db
        .select()
        .from(schema.agents)
        .where(eq(schema.agents.path, input.path))
        .limit(1);
      if (!agent) {
        return { success: false };
      }

      await db
        .update(schema.agents)
        .set({ archivedAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.agents.path, input.path));

      // Re-fetch and notify (agent is now archived)
      const updatedAgent = serializeAgent(
        { ...agent, archivedAt: new Date(), updatedAt: new Date() },
        null,
      );
      await notifyAgentChange(input.path, updatedAgent);

      return { success: true };
    }),

  updateAgent: publicProcedure
    .input(
      z.object({
        path: z.string(),
        metadata: z.record(z.string(), z.unknown()).nullable().optional(),
        shortStatus: z.string().min(0).max(30).optional(),
        isWorking: z.boolean().optional(),
        archivedAt: z.coerce.date().nullable().optional(),
      }),
    )
    .mutation(async ({ input }): Promise<SerializedAgent | null> => {
      const setValues: Partial<typeof schema.agents.$inferInsert> = {
        updatedAt: new Date(),
      };

      if ("metadata" in input) setValues.metadata = input.metadata ?? null;
      if ("shortStatus" in input) setValues.shortStatus = input.shortStatus ?? "";
      if ("isWorking" in input) setValues.isWorking = input.isWorking ?? false;
      if ("archivedAt" in input) setValues.archivedAt = input.archivedAt ?? null;

      await db.update(schema.agents).set(setValues).where(eq(schema.agents.path, input.path));

      const rows = await db
        .select({ agent: schema.agents, route: schema.agentRoutes })
        .from(schema.agents)
        .leftJoin(
          schema.agentRoutes,
          and(
            eq(schema.agentRoutes.agentPath, schema.agents.path),
            eq(schema.agentRoutes.active, true),
          ),
        )
        .where(eq(schema.agents.path, input.path))
        .limit(1);

      const row = rows[0];
      if (!row) return null;

      const serialized = serializeAgent(row.agent, row.route ?? null);
      await notifyAgentChange(input.path, serialized);
      return serialized;
    }),

  subscribeToAgentChanges: publicProcedure
    .input(z.object({ agentPath: z.string(), callbackUrl: z.string().url() }))
    .mutation(async ({ input }): Promise<{ success: boolean }> => {
      const existing = await db
        .select()
        .from(schema.agentSubscriptions)
        .where(
          and(
            eq(schema.agentSubscriptions.agentPath, input.agentPath),
            eq(schema.agentSubscriptions.callbackUrl, input.callbackUrl),
          ),
        )
        .limit(1);

      if (existing[0]) {
        await db
          .update(schema.agentSubscriptions)
          .set({ updatedAt: new Date() })
          .where(eq(schema.agentSubscriptions.id, existing[0].id));
      } else {
        await db.insert(schema.agentSubscriptions).values({
          agentPath: input.agentPath,
          callbackUrl: input.callbackUrl,
        });
      }

      return { success: true };
    }),

  unsubscribeFromAgentChanges: publicProcedure
    .input(z.object({ agentPath: z.string(), callbackUrl: z.string().url() }))
    .mutation(async ({ input }): Promise<{ success: boolean }> => {
      await db
        .delete(schema.agentSubscriptions)
        .where(
          and(
            eq(schema.agentSubscriptions.agentPath, input.agentPath),
            eq(schema.agentSubscriptions.callbackUrl, input.callbackUrl),
          ),
        );
      return { success: true };
    }),

  getActiveRoute: publicProcedure
    .input(z.object({ agentPath: z.string() }))
    .query(async ({ input }): Promise<SerializedAgentRoute | null> => {
      const [route] = await db
        .select()
        .from(schema.agentRoutes)
        .where(
          and(
            eq(schema.agentRoutes.agentPath, input.agentPath),
            eq(schema.agentRoutes.active, true),
          ),
        )
        .limit(1);
      return route ? serializeAgentRoute(route) : null;
    }),

  getOrCreateAgent: publicProcedure
    .input(
      z.object({
        agentPath: z.string(),
        createWithEvents: z.array(IterateEvent).default([]),
        // Internal override mostly for tests; prefer daemon-local provider paths.
        newAgentPath: z.string().default("/opencode/new"),
      }),
    )
    .mutation(async ({ input }) => {
      const { agentPath, createWithEvents, newAgentPath } = input;
      const validation = validateAgentPath(agentPath);
      if (!validation.valid) {
        throw new TRPCError({ code: "BAD_REQUEST", message: validation.error });
      }

      const result = db.transaction((tx) => {
        const getActiveRoute = () =>
          tx
            .select()
            .from(schema.agentRoutes)
            .where(
              and(eq(schema.agentRoutes.agentPath, agentPath), eq(schema.agentRoutes.active, true)),
            )
            .limit(1)
            .get();

        const unarchiveAgent = () => {
          const unarchived = tx
            .update(schema.agents)
            .set({ archivedAt: null, updatedAt: new Date() })
            .where(eq(schema.agents.path, agentPath))
            .returning()
            .get();

          if (!unarchived) {
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: `Failed to reactivate archived agent for ${agentPath}`,
            });
          }

          return unarchived;
        };

        let agent = tx
          .select()
          .from(schema.agents)
          .where(eq(schema.agents.path, agentPath))
          .limit(1)
          .get();
        let cleanupAgentOnCreateFailure = false;

        if (!agent) {
          const workingDirectory = getAgentWorkingDirectory();
          const created = tx
            .insert(schema.agents)
            .values({
              path: agentPath,
              workingDirectory,
            })
            .onConflictDoNothing()
            .returning()
            .get();

          if (created) {
            agent = created;
            cleanupAgentOnCreateFailure = true;
          } else {
            const existingByPath = tx
              .select()
              .from(schema.agents)
              .where(eq(schema.agents.path, agentPath))
              .limit(1)
              .get();

            if (!existingByPath) {
              throw new TRPCError({
                code: "INTERNAL_SERVER_ERROR",
                message: `Failed to load agent after creation conflict for ${agentPath}`,
              });
            }

            agent = existingByPath.archivedAt ? unarchiveAgent() : existingByPath;
          }
        } else if (agent.archivedAt) {
          agent = unarchiveAgent();
        }

        const route = getActiveRoute();

        if (route) {
          return {
            agent,
            route,
            pendingRoute: null,
            wasCreated: false,
            cleanupAgentOnCreateFailure: false,
          };
        }

        const pendingRoute = tx
          .insert(schema.agentRoutes)
          .values({
            agentPath,
            destination: "pending",
            active: true,
          })
          .onConflictDoNothing()
          .returning()
          .get();

        const routeAfterInsert = pendingRoute ?? getActiveRoute();
        if (!routeAfterInsert) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: `Failed to create or load pending route for ${agentPath}`,
          });
        }

        return {
          agent,
          route: routeAfterInsert,
          pendingRoute: pendingRoute ?? null,
          wasCreated: Boolean(pendingRoute),
          cleanupAgentOnCreateFailure,
        };
      });

      if (!result.wasCreated) {
        return {
          agent: serializeAgent(result.agent, result.route),
          route: result.route ? serializeAgentRoute(result.route) : null,
          wasCreated: false,
        };
      }

      if (!result.pendingRoute) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Missing pending route for ${agentPath}`,
        });
      }

      const daemonPort = process.env.PORT || "3001";
      const createUrl = newAgentPath.startsWith("http")
        ? newAgentPath
        : `http://localhost:${daemonPort}/api${newAgentPath}`;

      const createResponse = await fetch(createUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentPath,
          events: createWithEvents,
        }),
      });

      if (!createResponse.ok) {
        db.transaction((tx) => {
          tx.delete(schema.agentRoutes)
            .where(eq(schema.agentRoutes.id, result.pendingRoute.id))
            .run();
          if (result.cleanupAgentOnCreateFailure) {
            tx.delete(schema.agents).where(eq(schema.agents.path, agentPath)).run();
          }
        });

        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to create session: ${await createResponse.text()}`,
        });
      }

      const { route: routePath, sessionId } = (await createResponse.json()) as {
        route: string;
        sessionId?: string;
      };

      const routeMetadata =
        typeof sessionId === "string"
          ? ({
              harness: routePath.startsWith("/opencode/") ? "opencode" : "unknown",
              harnessHandle: sessionId,
              sessionId,
            } satisfies Record<string, unknown>)
          : undefined;

      const newRoute = db
        .update(schema.agentRoutes)
        .set({ destination: routePath, metadata: routeMetadata, updatedAt: new Date() })
        .where(eq(schema.agentRoutes.id, result.pendingRoute.id))
        .returning()
        .get();

      const finalRoute = newRoute ?? result.pendingRoute;

      return {
        agent: serializeAgent(result.agent, finalRoute),
        route: serializeAgentRoute(finalRoute),
        wasCreated: true,
      };
    }),

  // ============ Daemon Lifecycle ============

  /**
   * Restart the daemon process. The s6 supervisor will automatically restart it.
   * This is much faster than restarting the entire Daytona sandbox.
   */
  restartDaemon: publicProcedure.mutation(async (): Promise<{ success: boolean }> => {
    // Import lazily to avoid circular dependency issues at startup
    const { reportStatusToPlatform } = await import("../start.ts");

    // Report stopping status to platform before exiting
    await reportStatusToPlatform({ status: "stopping" }).catch((err) => {
      console.error("[restartDaemon] Failed to report stopping status:", err);
    });

    // Schedule exit after responding - s6 will restart us
    setTimeout(() => {
      console.log("[restartDaemon] Exiting for s6 restart...");
      process.exit(0);
    }, 100);

    return { success: true };
  }),
});

export type TRPCRouter = typeof trpcRouter;

export type { SerializedAgent, SerializedAgentRoute };
