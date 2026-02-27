import type { Context as HonoContext } from "hono";
import type { CloudflareEnv } from "../../env.ts";
import type { Variables } from "../types.ts";
import type { getAuth } from "../auth/auth.ts";

export type Context = {
  rawRequest: Request;
  auth: ReturnType<typeof getAuth>;
  env: CloudflareEnv;
  db: Variables["db"];
  session: Variables["session"];
  user: NonNullable<Variables["session"]>["user"] | null;
};

export function createContext(
  c: HonoContext<{ Bindings: CloudflareEnv; Variables: Variables }>,
): Context {
  return {
    rawRequest: c.req.raw,
    auth: c.var.auth,
    env: c.env,
    db: c.var.db,
    session: c.var.session,
    user: c.var.session?.user ?? null,
  };
}
