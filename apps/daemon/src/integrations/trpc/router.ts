import { z } from "zod/v4";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { TRPCError } from "@trpc/server";

import { db } from "../../db/index.ts";
import * as schema from "../../db/schema.ts";
import { startPiSession, stopPiSession } from "../../backend/agent-runtime.ts";
import { StreamManagerService } from "../../backend/event-stream/stream-manager.ts";
import { runEffect } from "../../backend/runtime.ts";
import type { StreamName } from "../../backend/event-stream/types.ts";
import { PiEventTypes } from "../../backend/agents/pi/types.ts";
import { createTRPCRouter, publicProcedure } from "./init.ts";

const CreateAgentInput = z.object({
  slug: z.string().min(1).max(100),
  harnessType: z.enum(schema.HarnessTypes),
});

const GetAgentInput = z.object({
  id: z.string().startsWith("agent_"),
});

const DeleteAgentInput = z.object({
  id: z.string().startsWith("agent_"),
});

const GetAgentBySlugInput = z.object({
  slug: z.string().min(1),
});

export const trpcRouter = createTRPCRouter({
  hello: publicProcedure.query(() => ({ message: "Hello from tRPC!" })),

  listAgents: publicProcedure.query(async () => {
    const result = await db.select().from(schema.agents).orderBy(schema.agents.createdAt);
    return result;
  }),

  getAgent: publicProcedure.input(GetAgentInput).query(async ({ input }) => {
    const [agent] = await db.select().from(schema.agents).where(eq(schema.agents.id, input.id));
    if (!agent) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Agent not found" });
    }
    return agent;
  }),

  getAgentSessionInfo: publicProcedure.input(GetAgentBySlugInput).query(async ({ input }) => {
    const [agent] = await db.select().from(schema.agents).where(eq(schema.agents.slug, input.slug));
    if (!agent) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Agent not found" });
    }

    if (agent.harnessType !== "pi") {
      return { sessionFile: null, cwd: null };
    }

    const events = await runEffect(
      Effect.gen(function* () {
        const manager = yield* StreamManagerService;
        return yield* manager.getFrom({ name: agent.slug as StreamName });
      }),
    );

    const sessionReadyEvent = events.find((event) => {
      const data = event.data as { type?: string } | null;
      return data?.type === PiEventTypes.SESSION_READY;
    });

    if (!sessionReadyEvent) {
      return { sessionFile: null, cwd: null };
    }

    const data = sessionReadyEvent.data as {
      payload?: { sessionFile?: string | null; cwd?: string };
    };
    return {
      sessionFile: data.payload?.sessionFile ?? null,
      cwd: data.payload?.cwd ?? null,
    };
  }),

  createAgent: publicProcedure.input(CreateAgentInput).mutation(async ({ input }) => {
    const [existing] = await db
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.slug, input.slug));
    if (existing) {
      throw new TRPCError({ code: "CONFLICT", message: "Agent with this slug already exists" });
    }

    let harnessAgentId: string;
    let harnessData: Record<string, unknown> = {};

    if (input.harnessType === "pi") {
      const { streamName, eventStreamId } = await startPiSession(input.slug);
      harnessAgentId = streamName;
      harnessData = { eventStreamId };
    } else {
      harnessAgentId = input.slug;
    }

    const [agent] = await db
      .insert(schema.agents)
      .values({
        slug: input.slug,
        harnessType: input.harnessType,
        harnessAgentId,
        harnessData,
      })
      .returning();

    return agent;
  }),

  deleteAgent: publicProcedure.input(DeleteAgentInput).mutation(async ({ input }) => {
    const [agent] = await db.select().from(schema.agents).where(eq(schema.agents.id, input.id));
    if (!agent) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Agent not found" });
    }

    if (agent.harnessType === "pi") {
      await stopPiSession(agent.harnessAgentId);
    }

    await db.delete(schema.agents).where(eq(schema.agents.id, input.id));

    await runEffect(
      Effect.gen(function* () {
        const manager = yield* StreamManagerService;
        yield* manager.delete({ name: agent.slug as StreamName }).pipe(Effect.ignore);
      }),
    );

    return { success: true };
  }),
});

export type TRPCRouter = typeof trpcRouter;
