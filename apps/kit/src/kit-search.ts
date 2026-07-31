import { z } from "zod";

export const DEFAULT_OS_BASE_HOST = "os.iterate.com";

export const KitSearch = z.object({
  host: z.string().default(DEFAULT_OS_BASE_HOST).catch(DEFAULT_OS_BASE_HOST),
  pcmHost: z.string().default("").catch(""),
  project: z.string().default("").catch(""),
});
