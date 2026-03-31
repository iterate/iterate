import { env } from "cloudflare:workers";
import type { worker } from "./alchemy.run.ts";

// This reflects the deployed runtime bindings from Worker(...bindings) in
// alchemy.run.ts. It intentionally excludes parse-only inputs like WORKER_ROUTES.
// Alchemy shows this `typeof worker.Env` pattern in:
// https://alchemy.run/guides/cloudflare-worker/
export type Env = typeof worker.Env;
export const Env = env as typeof worker.Env;
