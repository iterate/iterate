import type { Context as HonoContext } from "hono";
import type { CloudflareEnv } from "../../env.ts";
import type { Variables } from "../types.ts";

export type Context = {
  env: CloudflareEnv;
  db: Variables["db"];
  session: Variables["session"];
  user: NonNullable<Variables["session"]>["user"] | null;
};

export function createContext(
  c: HonoContext<{ Bindings: CloudflareEnv; Variables: Variables }>,
): Context {
  return {
    env: c.env,
    db: c.var.db,
    session: c.var.session,
    user: c.var.session?.user ?? null,
  };
}
