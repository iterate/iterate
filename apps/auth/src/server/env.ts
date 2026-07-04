import { env as _env } from "cloudflare:workers";
import { parseConfig } from "../config.ts";
import type { worker } from "../../alchemy.run.ts";
import type { CloudflareEmailBinding } from "./email.ts";

export type CloudflareEnv = typeof worker.Env & {
  EMAIL?: CloudflareEmailBinding;
};
export const env = _env as CloudflareEnv;

/**
 * The parsed auth runtime config (see src/config.ts). Read from the worker's
 * `APP_CONFIG` binding at isolate startup — the same module-scope timing the
 * `auth` singleton and D1 client already rely on, so `env` is populated. Server
 * code reads `config.*` instead of raw `env.*`; `env` now only carries the `DB`
 * binding (and `APP_CONFIG` itself).
 */
export const config = parseConfig(env);
