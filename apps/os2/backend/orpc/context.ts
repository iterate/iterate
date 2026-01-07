import { os } from "@orpc/server";
import type { CloudflareEnv } from "../../env.ts";
import type { DB } from "../db/client.ts";

export type Context = {
  headers: Headers;
  env: CloudflareEnv;
  db: DB;
};

export const base = os.$context<Context>();

export function createContext(request: Request, env: CloudflareEnv, db: DB): Context {
  return {
    headers: request.headers,
    env,
    db,
  };
}
