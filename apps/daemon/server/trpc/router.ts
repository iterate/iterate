import { homedir } from "node:os";
import { z } from "zod/v4";
import { eq, isNull } from "drizzle-orm";
import { db } from "../db/index.ts";
import * as schema from "../db/schema.ts";
import { type Agent, agentTypes } from "../db/schema.ts";
import { getOrCreateAgent, resetAgent as resetAgentService } from "../services/agent-manager.ts";
import {
  createTmuxSession,
  hasTmuxSession,
  listTmuxSessions,
  type TmuxSession,
} from "../tmux-control.ts";
import { pub } from "./init.ts";
import { platformRouter } from "./platform.ts";

const AgentType = z.enum(agentTypes);

/** Serialized agent with ISO date strings instead of Date objects */
type SerializedAgent = Omit<Agent, "createdAt" | "updatedAt" | "archivedAt"> & {
  createdAt: string | null;
  updatedAt: string | null;
  archivedAt: string | null;
};

function serializeAgent(agent: Agent): SerializedAgent {
  return {
    ...agent,
    createdAt: agent.createdAt?.toISOString() ?? null,
    updatedAt: agent.updatedAt?.toISOString() ?? null,
    archivedAt: agent.archivedAt?.toISOString() ?? null,
  };
}

/** Serialized tmux session with ISO date string */
type SerializedTmuxSession = Omit<TmuxSession, "created"> & {
  created: string;
};

function serializeTmuxSession(session: TmuxSession): SerializedTmuxSession {
  return {
    ...session,
    created: session.created.toISOString(),
  };
}

export const orpcRouter = {
  platform: platformRouter,
  hello: pub.handler(() => ({ message: "Hello from oRPC!" })),

  getServerCwd: pub.handler(() => {
    return { cwd: process.cwd(), homeDir: homedir() };
  }),

  // ============ Utility tmux sessions (for btop, logs, etc - NOT agents) ============

  listTmuxSessions: pub.handler((): SerializedTmuxSession[] => {
    return listTmuxSessions().map(serializeTmuxSession);
  }),

  ensureTmuxSession: pub
    .input(
      z.object({
        sessionName: z.string(),
        command: z.string(),
      }),
    )
    .handler(({ input }): { created: boolean } => {
      if (hasTmuxSession(input.sessionName)) {
        return { created: false };
      }
      createTmuxSession(input.sessionName, input.command);
      return { created: true };
    }),

  // ============ Agent CRUD ============

  listAgents: pub.handler(async (): Promise<SerializedAgent[]> => {
    const agents = await db
      .select()
      .from(schema.agents)
      .where(isNull(schema.agents.archivedAt))
      .orderBy(schema.agents.createdAt);
    return agents.map(serializeAgent);
  }),

  getAgent: pub
    .input(z.object({ slug: z.string() }))
    .handler(async ({ input }): Promise<SerializedAgent | null> => {
      const result = await db
        .select()
        .from(schema.agents)
        .where(eq(schema.agents.slug, input.slug))
        .limit(1);
      const agent = result[0];
      if (!agent || agent.archivedAt !== null) {
        return null;
      }
      return serializeAgent(agent);
    }),

  /**
   * Create an agent using the harness system.
   * For opencode agents, this creates an SDK session - no tmux.
   */
  createAgent: pub
    .input(
      z.object({
        slug: z
          .string()
          .min(1)
          .regex(/^[a-z0-9-]+$/),
        harnessType: AgentType,
        workingDirectory: z.string().min(1),
        initialPrompt: z.string().optional(),
      }),
    )
    .handler(async ({ input }): Promise<SerializedAgent> => {
      const result = await getOrCreateAgent({
        slug: input.slug,
        harnessType: input.harnessType,
        workingDirectory: input.workingDirectory,
        initialPrompt: input.initialPrompt,
      });

      return serializeAgent(result.agent);
    }),

  deleteAgent: pub
    .input(z.object({ slug: z.string() }))
    .handler(async ({ input }): Promise<{ success: boolean }> => {
      const [agent] = await db
        .select()
        .from(schema.agents)
        .where(eq(schema.agents.slug, input.slug))
        .limit(1);
      if (!agent) {
        return { success: false };
      }

      // For opencode agents, sessions are managed by opencode server
      // Just delete from DB - opencode server handles cleanup

      await db.delete(schema.agents).where(eq(schema.agents.slug, input.slug));
      return { success: true };
    }),

  archiveAgent: pub
    .input(z.object({ slug: z.string() }))
    .handler(async ({ input }): Promise<{ success: boolean }> => {
      const [agent] = await db
        .select()
        .from(schema.agents)
        .where(eq(schema.agents.slug, input.slug))
        .limit(1);
      if (!agent) {
        return { success: false };
      }

      // For opencode agents, sessions are managed by opencode server
      // Just archive in DB

      await db
        .update(schema.agents)
        .set({ archivedAt: new Date(), status: "stopped" })
        .where(eq(schema.agents.slug, input.slug));

      return { success: true };
    }),

  clearAllAgents: pub.handler(async (): Promise<{ archivedCount: number }> => {
    const activeAgents = await db
      .select()
      .from(schema.agents)
      .where(isNull(schema.agents.archivedAt));

    // For opencode agents, sessions are managed by opencode server
    // Just archive in DB

    const now = new Date();
    await db
      .update(schema.agents)
      .set({ archivedAt: now, status: "stopped" })
      .where(isNull(schema.agents.archivedAt));

    return { archivedCount: activeAgents.length };
  }),

  // ============ Agent Lifecycle ============
  // For opencode agents, sessions are always running via SDK
  // These procedures just update DB status

  startAgent: pub
    .input(z.object({ slug: z.string() }))
    .handler(async ({ input }): Promise<{ success: boolean; error?: string }> => {
      const [agent] = await db
        .select()
        .from(schema.agents)
        .where(eq(schema.agents.slug, input.slug))
        .limit(1);
      if (!agent) {
        return { success: false, error: "Agent not found" };
      }

      // For opencode agents, the session is already running via SDK
      // Just update DB status
      await db
        .update(schema.agents)
        .set({ status: "running" })
        .where(eq(schema.agents.slug, input.slug));

      return { success: true };
    }),

  stopAgent: pub
    .input(z.object({ slug: z.string() }))
    .handler(async ({ input }): Promise<{ success: boolean }> => {
      const [agent] = await db
        .select()
        .from(schema.agents)
        .where(eq(schema.agents.slug, input.slug))
        .limit(1);
      if (!agent) {
        return { success: false };
      }

      // For opencode agents, sessions are managed by opencode server
      // Just update DB status
      await db
        .update(schema.agents)
        .set({ status: "stopped" })
        .where(eq(schema.agents.slug, input.slug));

      return { success: true };
    }),

  resetAgent: pub
    .input(z.object({ slug: z.string() }))
    .handler(async ({ input }): Promise<{ success: boolean; error?: string }> => {
      const [agent] = await db
        .select()
        .from(schema.agents)
        .where(eq(schema.agents.slug, input.slug))
        .limit(1);
      if (!agent) {
        return { success: false, error: "Agent not found" };
      }

      // Archive old agent and create fresh session
      await resetAgentService({
        slug: input.slug,
        harnessType: agent.harnessType,
        workingDirectory: agent.workingDirectory,
        initialPrompt: agent.initialPrompt ?? undefined,
      });

      return { success: true };
    }),

  // ============ Daemon Lifecycle ============

  /**
   * Restart the daemon process. The pm2/s6 supervisor will automatically restart it.
   * This is much faster than restarting the entire Daytona sandbox.
   */
  restartDaemon: pub.handler(async (): Promise<{ success: boolean }> => {
    // Import lazily to avoid circular dependency issues at startup
    const { reportStatusToPlatform } = await import("../start.ts");

    // Report stopping status to platform before exiting
    await reportStatusToPlatform({ status: "stopping" }).catch((err) => {
      console.error("[restartDaemon] Failed to report stopping status:", err);
    });

    // Schedule exit after responding - supervisor will restart us
    setTimeout(() => {
      console.log("[restartDaemon] Exiting for supervisor restart...");
      process.exit(0);
    }, 100);

    return { success: true };
  }),
};

export type ORPCRouter = typeof orpcRouter;

export type { SerializedAgent, SerializedTmuxSession };
