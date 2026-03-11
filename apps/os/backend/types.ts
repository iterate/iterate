/**
 * Shared type definitions for backend workers.
 * This file intentionally avoids importing TanStack modules so it can
 * be safely used by isolated workers like egress-proxy.
 */
import type { Auth, AuthSession } from "./auth/auth.ts";
import type { DB } from "./db/client.ts";
import type { appRouter } from "./trpc/root.ts";

export type Variables = {
  auth: Auth;
  session: AuthSession;
  db: DB;
  trpcCaller: ReturnType<typeof appRouter.createCaller>;
};
