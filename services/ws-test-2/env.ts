import { env } from "cloudflare:workers";
import type { worker } from "./alchemy.run.ts";

export type Env = typeof worker.Env;
export const Env = env as typeof worker.Env;
