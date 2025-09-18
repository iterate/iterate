import type { FetchCreateContextFnOptions } from "@trpc/server/adapters/fetch";
import type { Context as HonoContext } from "hono";
import type { Variables } from "../worker";
import type { CloudflareEnv } from "../../env";

export async function createContext(
  c: HonoContext<{ Variables: Variables; Bindings: CloudflareEnv }>,
  _opts: FetchCreateContextFnOptions,
) {
  const { db, session } = c.var;
  return {
    db,
    session,
    user: session?.user || null,
  };
}

export type Context = Awaited<ReturnType<typeof createContext>>;
