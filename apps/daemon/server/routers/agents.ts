import { Hono, type Context } from "hono";
import { stream } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { propagation, context } from "@opentelemetry/api";
import { z } from "zod/v4";
import { TRPCError } from "@trpc/server";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/index.ts";
import * as schema from "../db/schema.ts";
import type { Agent, AgentRoute } from "../db/schema.ts";
import { IterateEvent } from "../types/events.ts";
import { validateAgentPath, extractAgentPathFromUrl } from "../utils/agent-path.ts";
import { getAgentWorkingDirectory } from "../utils/agent-working-directory.ts";
import { createTRPCRouter, publicProcedure } from "../trpc/init.ts";
import { withSpan } from "../utils/otel.ts";

// ────────────────────────────── Serialization ──────────────────────────────

export type SerializedAgentRoute = Omit<AgentRoute, "createdAt" | "updatedAt"> & {
  createdAt: string | null;
  updatedAt: string | null;
};

export type SerializedAgent = Omit<Agent, "createdAt" | "updatedAt" | "archivedAt"> & {
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

// ────────────────────────────── Notifications ──────────────────────────────

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

// ───────────────────── In-flight create promise map ────────────────────────

/**
 * When a create is in-flight for an agentPath, concurrent callers await the
 * same promise instead of returning a "pending" destination. This eliminates
 * the need for callers to poll `getActiveRoute`.
 */
const inflightCreates = new Map<string, Promise<AgentRoute>>();

// ──────────────────────────── tRPC sub-router ──────────────────────────────

export const agentTrpcRouter = createTRPCRouter({
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
            .values({ path: agentPath, workingDirectory })
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
            wasNewlyCreated: false,
            cleanupAgentOnCreateFailure: false,
          };
        }

        const pendingRoute = tx
          .insert(schema.agentRoutes)
          .values({ agentPath, destination: "pending", active: true })
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
          wasNewlyCreated: Boolean(pendingRoute),
          cleanupAgentOnCreateFailure,
        };
      });

      // ── Existing agent with ready route ──
      if (!result.wasNewlyCreated && result.route.destination !== "pending") {
        return {
          agent: serializeAgent(result.agent, result.route),
          route: serializeAgentRoute(result.route),
          wasNewlyCreated: false,
        };
      }

      // ── Existing agent with pending route: wait for the in-flight create ──
      if (!result.wasNewlyCreated) {
        const inflight = inflightCreates.get(agentPath);
        if (inflight) {
          const resolvedRoute = await inflight;
          return {
            agent: serializeAgent(result.agent, resolvedRoute),
            route: serializeAgentRoute(resolvedRoute),
            wasNewlyCreated: false,
          };
        }
        // No in-flight promise — should not happen, return what we have
        return {
          agent: serializeAgent(result.agent, result.route),
          route: serializeAgentRoute(result.route),
          wasNewlyCreated: false,
        };
      }

      // ── We are the creator: run the create and resolve waiters ──
      if (!result.pendingRoute) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Missing pending route for ${agentPath}`,
        });
      }

      let resolveInflight: (route: AgentRoute) => void;
      let rejectInflight: (reason: unknown) => void;
      const inflightPromise = new Promise<AgentRoute>((res, rej) => {
        resolveInflight = res;
        rejectInflight = rej;
      });
      inflightCreates.set(agentPath, inflightPromise);
      inflightPromise.catch(() => {}); // Prevent unhandled rejection when no waiters

      try {
        const daemonPort = process.env.PORT || "3001";
        const createUrl = newAgentPath.startsWith("http")
          ? newAgentPath
          : `http://localhost:${daemonPort}/api${newAgentPath}`;

        const createResponse = await fetch(createUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agentPath, events: createWithEvents }),
        });

        if (!createResponse.ok) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: `Failed to create session: ${await createResponse.text()}`,
          });
        }

        const created = (await createResponse.json()) as {
          route: string;
          metadata?: {
            agentHarness?: unknown;
            opencodeSessionId?: unknown;
          } | null;
        };
        const routePath = created.route;
        const routeMetadata =
          created.metadata?.agentHarness === "opencode" &&
          typeof created.metadata?.opencodeSessionId === "string" &&
          created.metadata.opencodeSessionId.length > 0
            ? ({
                agentHarness: "opencode",
                opencodeSessionId: created.metadata.opencodeSessionId,
              } satisfies Record<string, unknown>)
            : null;

        const newRoute = db
          .update(schema.agentRoutes)
          .set({ destination: routePath, metadata: routeMetadata, updatedAt: new Date() })
          .where(eq(schema.agentRoutes.id, result.pendingRoute!.id))
          .returning()
          .get();

        const finalRoute = newRoute ?? result.pendingRoute!;
        resolveInflight!(finalRoute);

        return {
          agent: serializeAgent(result.agent, finalRoute),
          route: serializeAgentRoute(finalRoute),
          wasNewlyCreated: true,
        };
      } catch (error) {
        // Clean up pending route on any failure — network errors, HTTP errors, etc.
        // Without this, the unique active-route index blocks future creates permanently.
        db.transaction((tx) => {
          tx.delete(schema.agentRoutes)
            .where(eq(schema.agentRoutes.id, result.pendingRoute!.id))
            .run();
          if (result.cleanupAgentOnCreateFailure) {
            tx.delete(schema.agents).where(eq(schema.agents.path, agentPath)).run();
          }
        });
        rejectInflight!(error);
        throw error;
      } finally {
        inflightCreates.delete(agentPath);
      }
    }),
});

// ─────────────────────────── Hono HTTP router ──────────────────────────────

export const agentsRouter = new Hono();

const DAEMON_PORT = process.env.PORT || "3001";
const DAEMON_BASE_URL = `http://localhost:${DAEMON_PORT}`;

const FORWARDED_HEADERS = ["content-type", "cache-control", "x-request-id", "x-correlation-id"];

function getNewAgentPath(agentPath: string): string {
  const prefix = agentPath.split("/")[1];
  switch (prefix) {
    case "pi":
      return "/pi/new";
    case "claude":
      return "/claude/new";
    case "codex":
      return "/codex/new";
    default:
      return "/opencode/new";
  }
}

async function forwardAgentRequest(c: Context): Promise<Response> {
  const agentPath = extractAgentPathFromUrl(c.req.path, "/api/agents");

  if (!agentPath) {
    return c.json({ error: "Invalid agent path" }, 400);
  }

  const method = c.req.method;
  if (method !== "GET" && method !== "POST") {
    return c.json({ error: `Method not allowed: ${method}` }, 405);
  }

  return withSpan(
    "daemon.agent.forward",
    { attributes: { "agent.path": agentPath, "http.method": method } },
    async (span) => {
      const caller = agentTrpcRouter.createCaller({});
      const { route } = await caller.getOrCreateAgent({
        agentPath,
        createWithEvents: [],
        newAgentPath: getNewAgentPath(agentPath),
      });

      if (!route || route.destination === "pending") {
        span.setAttribute("agent.route_ready", false);
        return c.json({ error: "Agent route is not ready", agentPath }, 503);
      }

      const destination = route.destination.startsWith("http")
        ? route.destination
        : `${DAEMON_BASE_URL}/api${route.destination}`;

      span.setAttribute("agent.destination", destination);

      const upstreamHeaders = new Headers();
      const accept = c.req.header("accept");
      if (accept) upstreamHeaders.set("Accept", accept);
      if (method === "POST") {
        upstreamHeaders.set("Content-Type", "application/json");
      }
      upstreamHeaders.set("x-iterate-agent-path", agentPath);

      propagation.inject(context.active(), upstreamHeaders, {
        set(carrier, key, value) {
          carrier.set(key, value);
        },
      });

      const upstreamResponse = await fetch(destination, {
        method,
        headers: upstreamHeaders,
        body: method === "POST" ? JSON.stringify(await c.req.json()) : undefined,
      });

      span.setAttribute("agent.upstream_status", upstreamResponse.status);

      for (const header of FORWARDED_HEADERS) {
        const value = upstreamResponse.headers.get(header);
        if (value) {
          c.header(header, value);
        }
      }

      c.status(upstreamResponse.status as ContentfulStatusCode);

      if (upstreamResponse.body) {
        return stream(c, async (streamWriter) => {
          const reader = upstreamResponse.body!.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              await streamWriter.write(value);
            }
          } finally {
            reader.releaseLock();
          }
        });
      }

      return c.body(null);
    },
  );
}

agentsRouter.post("/*", async (c) => forwardAgentRequest(c));
