import { homedir } from "node:os";
import { z } from "zod/v4";
import { eq } from "drizzle-orm";
import {
  buildSessionName,
  createTmuxSession,
  gracefulStop,
  hasTmuxSession,
  listTmuxSessions,
  propagateApiKeysToTmux,
  respawnPane,
  triggerResurrectSave,
  type TmuxSession,
} from "../tmux-control.ts";

propagateApiKeysToTmux();
import { getHarness, getCommandString } from "../agent-harness.ts";
import { db } from "../db/index.ts";
import * as schema from "../db/schema.ts";
import { type Session, harnessTypes } from "../db/schema.ts";
import { createTRPCRouter, publicProcedure } from "./init.ts";

const HarnessType = z.enum(harnessTypes);

export const trpcRouter = createTRPCRouter({
  hello: publicProcedure.query(() => ({ message: "Hello from tRPC!" })),

  getServerCwd: publicProcedure.query(() => {
    return { cwd: process.cwd(), homeDir: homedir() };
  }),

  // Legacy tmux session procedures (for backwards compatibility)
  listTmuxSessions: publicProcedure.query((): TmuxSession[] => {
    return listTmuxSessions();
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

  // ============ Session CRUD ============

  listSessions: publicProcedure.query(async (): Promise<Session[]> => {
    return db.select().from(schema.sessions).orderBy(schema.sessions.createdAt);
  }),

  getSession: publicProcedure
    .input(z.object({ slug: z.string() }))
    .query(async ({ input }): Promise<Session | null> => {
      const result = await db
        .select()
        .from(schema.sessions)
        .where(eq(schema.sessions.slug, input.slug))
        .limit(1);
      return result[0] ?? null;
    }),

  createSession: publicProcedure
    .input(
      z.object({
        slug: z
          .string()
          .min(1)
          .regex(/^[a-z0-9-]+$/),
        harnessType: HarnessType,
        workingDirectory: z.string().min(1),
        initialPrompt: z.string().optional(),
      }),
    )
    .mutation(async ({ input }): Promise<Session> => {
      const [session] = await db
        .insert(schema.sessions)
        .values({
          slug: input.slug,
          harnessType: input.harnessType,
          workingDirectory: input.workingDirectory,
          status: "stopped",
          initialPrompt: input.initialPrompt,
        })
        .returning();

      return session;
    }),

  deleteSession: publicProcedure
    .input(z.object({ slug: z.string() }))
    .mutation(async ({ input }): Promise<{ success: boolean }> => {
      const [session] = await db
        .select()
        .from(schema.sessions)
        .where(eq(schema.sessions.slug, input.slug))
        .limit(1);
      if (!session) {
        return { success: false };
      }

      const tmuxSession = buildSessionName(input.slug);
      if (hasTmuxSession(tmuxSession)) {
        await gracefulStop(tmuxSession);
      }

      await db.delete(schema.sessions).where(eq(schema.sessions.slug, input.slug));
      triggerResurrectSave();
      return { success: true };
    }),

  clearAllSessions: publicProcedure.mutation(async (): Promise<{ deletedCount: number }> => {
    const activeSessions = await db.select().from(schema.sessions);

    for (const session of activeSessions) {
      const tmuxSession = buildSessionName(session.slug);
      try {
        if (hasTmuxSession(tmuxSession)) {
          await gracefulStop(tmuxSession);
        }
      } catch {
        // Best effort - ignore tmux cleanup failures
      }
    }

    await db.delete(schema.sessions);
    triggerResurrectSave();

    return { deletedCount: activeSessions.length };
  }),

  // ============ Session Lifecycle ============

  startSession: publicProcedure
    .input(z.object({ slug: z.string() }))
    .mutation(async ({ input }): Promise<{ success: boolean; error?: string }> => {
      const [session] = await db
        .select()
        .from(schema.sessions)
        .where(eq(schema.sessions.slug, input.slug))
        .limit(1);
      if (!session) {
        return { success: false, error: "Session not found" };
      }

      if (!session.workingDirectory) {
        return { success: false, error: "Session has no working directory configured" };
      }

      const tmuxSession = buildSessionName(input.slug);

      if (hasTmuxSession(tmuxSession)) {
        await db
          .update(schema.sessions)
          .set({ status: "running", updatedAt: new Date() })
          .where(eq(schema.sessions.slug, input.slug));
        return { success: true };
      }

      const harness = getHarness(session.harnessType);
      const command = harness.getStartCommand(session.workingDirectory, {
        prompt: session.initialPrompt ?? undefined,
      });

      const wrapperCommand = buildTmuxCommand(command, session.workingDirectory);
      const success = createTmuxSession(tmuxSession, wrapperCommand);

      if (success) {
        await db
          .update(schema.sessions)
          .set({ status: "running", updatedAt: new Date() })
          .where(eq(schema.sessions.slug, input.slug));
        triggerResurrectSave();
      } else {
        await db
          .update(schema.sessions)
          .set({ status: "error", updatedAt: new Date() })
          .where(eq(schema.sessions.slug, input.slug));
      }

      return { success };
    }),

  stopSession: publicProcedure
    .input(z.object({ slug: z.string() }))
    .mutation(async ({ input }): Promise<{ success: boolean }> => {
      const [session] = await db
        .select()
        .from(schema.sessions)
        .where(eq(schema.sessions.slug, input.slug))
        .limit(1);
      if (!session) {
        return { success: false };
      }

      const tmuxSession = buildSessionName(input.slug);

      if (hasTmuxSession(tmuxSession)) {
        await gracefulStop(tmuxSession);
        triggerResurrectSave();
      }

      // Always update DB status after initiating stop, regardless of gracefulStop result
      // The tmux hook will reconcile the actual state
      await db
        .update(schema.sessions)
        .set({ status: "stopped", updatedAt: new Date() })
        .where(eq(schema.sessions.slug, input.slug));

      return { success: true };
    }),

  resetSession: publicProcedure
    .input(z.object({ slug: z.string() }))
    .mutation(async ({ input }): Promise<{ success: boolean; error?: string }> => {
      const [session] = await db
        .select()
        .from(schema.sessions)
        .where(eq(schema.sessions.slug, input.slug))
        .limit(1);
      if (!session) {
        return { success: false, error: "Session not found" };
      }

      if (!session.workingDirectory) {
        return { success: false, error: "Session not properly configured" };
      }

      const harness = getHarness(session.harnessType);
      const command = harness.getStartCommand(session.workingDirectory, {
        prompt: session.initialPrompt ?? undefined,
      });
      const wrapperCommand = buildTmuxCommand(command, session.workingDirectory);

      const tmuxSession = buildSessionName(input.slug);
      if (!hasTmuxSession(tmuxSession)) {
        const success = createTmuxSession(tmuxSession, wrapperCommand);
        if (success) {
          await db
            .update(schema.sessions)
            .set({ status: "running", updatedAt: new Date() })
            .where(eq(schema.sessions.slug, input.slug));
          triggerResurrectSave();
        }
        return { success };
      }

      const success = respawnPane(tmuxSession, wrapperCommand);
      if (success) {
        await db
          .update(schema.sessions)
          .set({ status: "running", updatedAt: new Date() })
          .where(eq(schema.sessions.slug, input.slug));
        triggerResurrectSave();
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
