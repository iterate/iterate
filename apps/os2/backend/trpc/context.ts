import type { Context as HonoContext } from "hono";
import type { Variables } from "../worker.ts";
import type { CloudflareEnv } from "../../env.ts";

export function createContext(c: HonoContext<{ Variables: Variables; Bindings: CloudflareEnv }>) {
  const { db, session } = c.var;
  return {
    db,
    session,
    user: session?.user || null,
    env: c.env,
  };
}

export type Context = ReturnType<typeof createContext>;
