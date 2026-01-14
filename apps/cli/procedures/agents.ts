import { z } from "zod/v4";
import { t } from "../trpc.ts";

export const agentsRouter = t.router({
  list: t.procedure.meta({ description: "List all agents" }).query(() => {
    // TODO: implement real agent listing
    return [
      { id: "agent-1", name: "Claude Agent", status: "running" },
      { id: "agent-2", name: "GPT Agent", status: "stopped" },
    ];
  }),

  get: t.procedure
    .meta({ description: "Get agent by ID" })
    .input(z.object({ id: z.string().describe("Agent ID") }))
    .query(({ input }) => {
      // TODO: implement real agent lookup
      return {
        id: input.id,
        name: `Agent ${input.id}`,
        status: "running",
        createdAt: new Date().toISOString(),
      };
    }),

  start: t.procedure
    .meta({ description: "Start an agent" })
    .input(z.object({ id: z.string().describe("Agent ID") }))
    .mutation(({ input }) => {
      // TODO: implement real agent start
      return { success: true, message: `Agent ${input.id} started` };
    }),

  stop: t.procedure
    .meta({ description: "Stop an agent" })
    .input(z.object({ id: z.string().describe("Agent ID") }))
    .mutation(({ input }) => {
      // TODO: implement real agent stop
      return { success: true, message: `Agent ${input.id} stopped` };
    }),
});
