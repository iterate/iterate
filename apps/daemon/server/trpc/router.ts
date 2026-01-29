import { homedir } from "node:os";
import { z } from "zod/v4";
import { TRPCError } from "@trpc/server";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/index.ts";
import * as schema from "../db/schema.ts";
import type { Agent, AgentRoute } from "../db/schema.ts";
import { validateAgentPath } from "../utils/agent-path.ts";
import { getAgentWorkingDirectory } from "../utils/agent-working-directory.ts";
import { createTRPCRouter, publicProcedure } from "./init.ts";
import { platformRouter, getCustomerRepoPath } from "./platform.ts";

const IterateEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("prompt"), message: z.string() }),
]);

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

async function waitForActiveRoute(agentPath: string): Promise<AgentRoute | null> {
  const maxAttempts = 10;
  const delayMs = 25;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const route = db
      .select()
      .from(schema.agentRoutes)
      .where(and(eq(schema.agentRoutes.agentPath, agentPath), eq(schema.agentRoutes.active, true)))
      .limit(1)
      .get();

    if (route && route.destination !== "pending") {
      return route;
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  return null;
}

export const trpcRouter = createTRPCRouter({
  platform: platformRouter,
  hello: publicProcedure.query(() => ({ message: "Hello from tRPC!" })),

  getServerCwd: publicProcedure.query(() => {
    return {
      cwd: process.cwd(),
      homeDir: homedir(),
      customerRepoPath: getCustomerRepoPath(),
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
        .set({ archivedAt: new Date() })
        .where(eq(schema.agents.path, input.path));

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
        const existing = tx
          .select()
          .from(schema.agents)
          .where(and(eq(schema.agents.path, agentPath), isNull(schema.agents.archivedAt)))
          .limit(1)
          .get();

        if (existing) {
          const route = tx
            .select()
            .from(schema.agentRoutes)
            .where(
              and(eq(schema.agentRoutes.agentPath, agentPath), eq(schema.agentRoutes.active, true)),
            )
            .limit(1)
            .get();

          return {
            agent: existing,
            route: route ?? null,
            pendingRoute: null,
            wasCreated: false,
          };
        }

        const workingDirectory = getAgentWorkingDirectory();

        const newAgent = tx
          .insert(schema.agents)
          .values({
            path: agentPath,
            workingDirectory,
          })
          .onConflictDoNothing()
          .returning()
          .get();

        if (!newAgent) {
          const agent = tx
            .select()
            .from(schema.agents)
            .where(and(eq(schema.agents.path, agentPath), isNull(schema.agents.archivedAt)))
            .limit(1)
            .get();

          const route = tx
            .select()
            .from(schema.agentRoutes)
            .where(
              and(eq(schema.agentRoutes.agentPath, agentPath), eq(schema.agentRoutes.active, true)),
            )
            .limit(1)
            .get();

          if (!agent) {
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: `Failed to load agent after creation conflict for ${agentPath}`,
            });
          }

          return {
            agent,
            route: route ?? null,
            pendingRoute: null,
            wasCreated: false,
          };
        }

        const pendingRoute = tx
          .insert(schema.agentRoutes)
          .values({
            agentPath,
            destination: "pending",
            active: true,
          })
          .returning()
          .get();

        if (!pendingRoute) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: `Failed to create pending route for ${agentPath}`,
          });
        }

        return {
          agent: newAgent,
          route: pendingRoute,
          pendingRoute,
          wasCreated: true,
        };
      });

      if (!result.wasCreated) {
        if (result.route?.destination === "pending") {
          const refreshedRoute = await waitForActiveRoute(agentPath);
          const finalRoute = refreshedRoute ?? result.route;

          return {
            agent: serializeAgent(result.agent, finalRoute),
            route: finalRoute ? serializeAgentRoute(finalRoute) : null,
            wasCreated: false,
          };
        }

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
          tx.delete(schema.agents).where(eq(schema.agents.path, agentPath)).run();
        });

        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Failed to create session: ${await createResponse.text()}`,
        });
      }

      const { route: routePath } = (await createResponse.json()) as { route: string };

      const newRoute = db
        .update(schema.agentRoutes)
        .set({ destination: routePath, updatedAt: new Date() })
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
