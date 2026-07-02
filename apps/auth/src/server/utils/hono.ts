import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { SERVICE_TOKEN_HEADER } from "@iterate-com/auth-contract";
import { auth, type AuthSession } from "../auth.ts";
import { db, type DB } from "../db/index.ts";
import type { CloudflareEnv } from "../env.ts";

export type Variables = {
  db: DB;
  session: AuthSession;
  serviceAuthorized: boolean;
};

export const hono = () => new Hono<{ Bindings: CloudflareEnv; Variables: Variables }>();

// Resolves the two HTTP credentials every request may carry:
//  - the better-auth session cookie (browser UI + SSR),
//  - SERVICE_AUTH_TOKEN in the x-iterate-service-token header (deploy-time
//    Node scripts calling /api/orpc internal.* — see orpc/routers/internal.ts).
// Runtime OS→auth traffic authenticates by holding the AUTH service binding
// and never passes through here (worker.ts RPC methods).
export const variablesProvider = () =>
  createMiddleware<{
    Variables: Variables;
    Bindings: CloudflareEnv;
  }>(async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    const serviceAuthorized = authenticateServiceRequest({
      expectedServiceToken: c.env.SERVICE_AUTH_TOKEN,
      providedServiceToken: c.req.header(SERVICE_TOKEN_HEADER),
    });

    c.set("session", session);
    c.set("db", db);
    c.set("serviceAuthorized", serviceAuthorized);
    return next();
  });

function authenticateServiceRequest(input: {
  expectedServiceToken: string | undefined;
  providedServiceToken: string | undefined;
}) {
  const expectedServiceToken = input.expectedServiceToken?.trim();
  const providedServiceToken = input.providedServiceToken?.trim();
  return Boolean(expectedServiceToken && providedServiceToken === expectedServiceToken);
}
