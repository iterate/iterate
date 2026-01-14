import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { z } from "zod/v4";
import { eq, isNull } from "drizzle-orm";
import {
  createTmuxSession,
  gracefulStop,
  hasTmuxSession,
  listTmuxSessions,
  propagateApiKeysToTmux,
  respawnPane,
  type TmuxSession,
} from "../tmux-control.ts";

propagateApiKeysToTmux();
import { getHarness, getCommandString } from "../agent-harness.ts";
import { db } from "../db/index.ts";
import * as schema from "../db/schema.ts";
import { type Agent, agentTypes } from "../db/schema.ts";
import { createTRPCRouter, publicProcedure } from "./init.ts";
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

export const trpcRouter = createTRPCRouter({
  platform: platformRouter,
  hello: publicProcedure.query(() => ({ message: "Hello from tRPC!" })),

  getServerCwd: publicProcedure.query(() => {
    return { cwd: process.cwd(), homeDir: homedir() };
  }),

  // Legacy tmux session procedures (for backwards compatibility)
  listTmuxSessions: publicProcedure.query((): SerializedTmuxSession[] => {
    return listTmuxSessions().map(serializeTmuxSession);
  }),

  ensureTmuxSession: publicProcedure
    .input(
      z.object({
        sessionName: z.string(),
        command: z.string(),
      }),
    )
    .mutation(({ input }): { created: boolean } => {
      if (hasTmuxSession(input.sessionName)) {
        return { created: false };
      }
      createTmuxSession(input.sessionName, input.command);
      return { created: true };
    }),

  // ============ Agent CRUD ============

  listAgents: publicProcedure.query(async (): Promise<SerializedAgent[]> => {
    const agents = await db
      .select()
      .from(schema.agents)
      .where(isNull(schema.agents.archivedAt))
      .orderBy(schema.agents.createdAt);
    return agents.map(serializeAgent);
  }),

  getAgent: publicProcedure
    .input(z.object({ slug: z.string() }))
    .query(async ({ input }): Promise<SerializedAgent | null> => {
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

  createAgent: publicProcedure
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
    .mutation(async ({ input }): Promise<SerializedAgent> => {
      const id = randomUUID();
      const tmuxSession = `agent-${id.slice(0, 8)}`;

      const [agent] = await db
        .insert(schema.agents)
        .values({
          id,
          slug: input.slug,
          harnessType: input.harnessType,
          tmuxSession,
          workingDirectory: input.workingDirectory,
          status: "stopped",
          initialPrompt: input.initialPrompt,
        })
        .returning();

      return serializeAgent(agent);
    }),

  deleteAgent: publicProcedure
    .input(z.object({ slug: z.string() }))
    .mutation(async ({ input }): Promise<{ success: boolean }> => {
      const [agent] = await db
        .select()
        .from(schema.agents)
        .where(eq(schema.agents.slug, input.slug))
        .limit(1);
      if (!agent) {
        return { success: false };
      }

      if (agent.tmuxSession && hasTmuxSession(agent.tmuxSession)) {
        await gracefulStop(agent.tmuxSession);
      }

      await db.delete(schema.agents).where(eq(schema.agents.slug, input.slug));
      return { success: true };
    }),

  archiveAgent: publicProcedure
    .input(z.object({ slug: z.string() }))
    .mutation(async ({ input }): Promise<{ success: boolean }> => {
      const [agent] = await db
        .select()
        .from(schema.agents)
        .where(eq(schema.agents.slug, input.slug))
        .limit(1);
      if (!agent) {
        return { success: false };
      }

      if (agent.tmuxSession && hasTmuxSession(agent.tmuxSession)) {
        await gracefulStop(agent.tmuxSession);
      }

      await db
        .update(schema.agents)
        .set({ archivedAt: new Date(), status: "stopped" })
        .where(eq(schema.agents.slug, input.slug));

      return { success: true };
    }),

  clearAllAgents: publicProcedure.mutation(async (): Promise<{ archivedCount: number }> => {
    const activeAgents = await db
      .select()
      .from(schema.agents)
      .where(isNull(schema.agents.archivedAt));

    for (const agent of activeAgents) {
      if (agent.tmuxSession) {
        try {
          if (hasTmuxSession(agent.tmuxSession)) {
            await gracefulStop(agent.tmuxSession);
          }
        } catch {
          // Best effort - ignore tmux cleanup failures
        }
      }
    }

    const now = new Date();
    await db
      .update(schema.agents)
      .set({ archivedAt: now, status: "stopped" })
      .where(isNull(schema.agents.archivedAt));

    return { archivedCount: activeAgents.length };
  }),

  // ============ Agent Lifecycle ============

  startAgent: publicProcedure
    .input(z.object({ slug: z.string() }))
    .mutation(async ({ input }): Promise<{ success: boolean; error?: string }> => {
      const [agent] = await db
        .select()
        .from(schema.agents)
        .where(eq(schema.agents.slug, input.slug))
        .limit(1);
      if (!agent) {
        return { success: false, error: "Agent not found" };
      }

      if (!agent.tmuxSession) {
        return { success: false, error: "Agent has no tmux session configured" };
      }

      if (hasTmuxSession(agent.tmuxSession)) {
        await db
          .update(schema.agents)
          .set({ status: "running" })
          .where(eq(schema.agents.slug, input.slug));
        return { success: true };
      }

      const harness = getHarness(agent.harnessType);
      const command = harness.getStartCommand(agent.workingDirectory, {
        prompt: agent.initialPrompt ?? undefined,
      });

      const wrapperCommand = buildTmuxCommand(command, agent.workingDirectory);
      const success = createTmuxSession(agent.tmuxSession, wrapperCommand);

      if (success) {
        await db
          .update(schema.agents)
          .set({ status: "running" })
          .where(eq(schema.agents.slug, input.slug));
      } else {
        await db
          .update(schema.agents)
          .set({ status: "error" })
          .where(eq(schema.agents.slug, input.slug));
      }

      return { success };
    }),

  stopAgent: publicProcedure
    .input(z.object({ slug: z.string() }))
    .mutation(async ({ input }): Promise<{ success: boolean }> => {
      const [agent] = await db
        .select()
        .from(schema.agents)
        .where(eq(schema.agents.slug, input.slug))
        .limit(1);
      if (!agent || !agent.tmuxSession) {
        return { success: false };
      }

      if (hasTmuxSession(agent.tmuxSession)) {
        await gracefulStop(agent.tmuxSession);
      }

      await db
        .update(schema.agents)
        .set({ status: "stopped" })
        .where(eq(schema.agents.slug, input.slug));
      return { success: true };
    }),

  resetAgent: publicProcedure
    .input(z.object({ slug: z.string() }))
    .mutation(async ({ input }): Promise<{ success: boolean; error?: string }> => {
      const [agent] = await db
        .select()
        .from(schema.agents)
        .where(eq(schema.agents.slug, input.slug))
        .limit(1);
      if (!agent) {
        return { success: false, error: "Agent not found" };
      }

      if (!agent.tmuxSession) {
        return { success: false, error: "Agent not properly configured" };
      }

      const harness = getHarness(agent.harnessType);
      const command = harness.getStartCommand(agent.workingDirectory, {
        prompt: agent.initialPrompt ?? undefined,
      });
      const wrapperCommand = buildTmuxCommand(command, agent.workingDirectory);

      if (!hasTmuxSession(agent.tmuxSession)) {
        const success = createTmuxSession(agent.tmuxSession, wrapperCommand);
        if (success) {
          await db
            .update(schema.agents)
            .set({ status: "running" })
            .where(eq(schema.agents.slug, input.slug));
        }
        return { success };
      }

      const success = respawnPane(agent.tmuxSession, wrapperCommand);
      if (success) {
        await db
          .update(schema.agents)
          .set({ status: "running" })
          .where(eq(schema.agents.slug, input.slug));
      }
      return { success };
    }),
});

function buildTmuxCommand(agentCommand: string[], workingDirectory: string): string {
  const cmd = getCommandString(agentCommand);
  const script = `cd "${workingDirectory}" && ${cmd}; exit_code=$?; if [ $exit_code -ne 0 ]; then echo ""; echo "Process exited with code: $exit_code"; echo "Press Enter to close..."; read; fi`;
  return `bash -c ${JSON.stringify(script)}`;
}

export type TRPCRouter = typeof trpcRouter;

export type { SerializedAgent, SerializedTmuxSession };
