import { os } from "@orpc/server";
import { z } from "zod";
import { runBuiltServer } from "./start.ts";

const StartInput = z.object({
  port: z.coerce.number().int().min(0).max(65535).default(0),
});

export const router = os.router({
  start: os
    .input(StartInput)
    .meta({
      description: "Run the built server",
      default: true,
    })
    .handler(async ({ input, signal }) => {
      const code = await runBuiltServer({
        port: input.port,
        env: process.env,
        signal,
      });

      if (signal?.aborted) {
        return {
          ok: true as const,
          port: input.port,
        };
      }

      if (code !== 0) {
        throw new Error(`[start] built server exited with code ${code}.`);
      }

      return {
        ok: true as const,
        port: input.port,
      };
    }),
});
