import { z } from "zod";

/**
 * Browser-safe log filtering config shared by app config parsing and runtime
 * logging. Keep this separate from the request runtime so route modules can
 * import handler plugins without pulling in server-only dependencies.
 */
export const AppRequestLogFilterRule = z.object({
  path: z.string().trim().min(1).optional(),
  statuses: z.array(z.number().int()).optional(),
  minStatus: z.number().int().optional(),
  action: z.enum(["keep", "drop"]),
});

export const AppRequestLogFilteringConfig = z.object({
  rules: z.array(AppRequestLogFilterRule).default([]),
});

export const AppLogsConfig = z.object({
  stdoutFormat: z.enum(["raw", "pretty"]),
  filtering: AppRequestLogFilteringConfig.default({
    rules: [],
  }),
});

export type AppLogsConfig = z.infer<typeof AppLogsConfig>;
export type AppRequestLogFilterRule = z.infer<typeof AppRequestLogFilterRule>;
export type AppRequestLogFilteringConfig = z.infer<typeof AppRequestLogFilteringConfig>;
