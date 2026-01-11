import { z } from "zod/v4";
import { createTRPCRouter, publicProcedure } from "./init.ts";
import { TmuxControlMode, type TmuxSession } from "@/backend/tmux-control.ts";

export const trpcRouter = createTRPCRouter({
  hello: publicProcedure.query(() => ({ message: "Hello from tRPC!" })),

  // List all tmux sessions
  listTmuxSessions: publicProcedure.query(async (): Promise<TmuxSession[]> => {
    const tmux = await TmuxControlMode.getInstance();
    return tmux.listTmuxSessions();
  }),

  // Create a new tmux session
  createTmuxSession: publicProcedure
    .input(z.object({ name: z.string().optional() }))
    .mutation(async ({ input }) => {
      const tmux = await TmuxControlMode.getInstance();
      const name = await tmux.createTmuxSession(input.name);
      return { name };
    }),

  // Kill a tmux session
  killTmuxSession: publicProcedure
    .input(z.object({ name: z.string() }))
    .mutation(async ({ input }) => {
      const tmux = await TmuxControlMode.getInstance();
      await tmux.killTmuxSession(input.name);
      return { success: true };
    }),
});

export type TRPCRouter = typeof trpcRouter;
