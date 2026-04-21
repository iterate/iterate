/**
 * Shared type definitions for backend workers.
 * This file intentionally avoids importing TanStack modules so it can
 * be safely used by isolated workers like egress-proxy.
 */
import type { RouterClient } from "@orpc/server";
import type { DB } from "./db/client.ts";
import type { AppRouter } from "./orpc/root.ts";
import type { MirroredAuthSession } from "./auth/auth-worker-session.ts";

export type Variables = {
  session: MirroredAuthSession | null;
  db: DB;
  orpcCaller: RouterClient<AppRouter>;
};
