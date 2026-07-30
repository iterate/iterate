import { env as workerEnv } from "cloudflare:workers";

export type Env = Cloudflare.Env;
export const Env = workerEnv;
