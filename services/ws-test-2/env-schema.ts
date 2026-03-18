import { z } from "zod";

export const WorkerEnvVars = z.object({
  WORKER_ROUTES: z
    .string()
    .trim()
    .optional()
    .transform((value) =>
      value
        ? value
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean)
        : [],
    ),
  ENABLE_PTY: z.stringbool().default(false),
});
