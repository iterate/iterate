import { z } from "zod";

/**
 * App-level env shared by every runtime.
 */
export const ExampleAppEnv = z.object({
  VITE_POSTHOG_PUBLIC_KEY: z.string().trim().min(1, "VITE_POSTHOG_PUBLIC_KEY is required"),
  VITE_POSTHOG_PROXY_URL: z.string().trim().min(1).default("/api/integrations/posthog/proxy"),
  PIRATE_SECRET: z.string().trim().min(1, "PIRATE_SECRET is required"),
});

export const ExampleNodeEnv = ExampleAppEnv.extend({
  HOST: z.string().trim().min(1).default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(17402),
  EXAMPLE_DB_PATH: z.string().trim().min(1).default("example.sqlite"),
});

export type ExampleAppEnv = z.infer<typeof ExampleAppEnv>;
export type ExampleNodeEnv = z.infer<typeof ExampleNodeEnv>;
export type ExampleRuntimeEnv = ExampleAppEnv;
