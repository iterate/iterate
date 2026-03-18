import { env as _env } from "cloudflare:workers";
import type { worker } from "../../alchemy.run.ts";

export type CloudflareEnv = typeof worker.Env;
export const env = _env as CloudflareEnv;
