import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { auth, type AuthSession, verifyProjectIngressToken } from "../auth.ts";
import { db, type DB } from "../db/index.ts";
import type { CloudflareEnv } from "../env.ts";

export type Variables = {
  db: DB;
  session: AuthSession;
  serviceAuthorized: boolean;
};

export const hono = () => new Hono<{ Bindings: CloudflareEnv; Variables: Variables }>();

export const variablesProvider = () =>
  createMiddleware<{
    Variables: Variables;
    Bindings: CloudflareEnv;
  }>(async (c, next) => {
    let session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) {
      const authorization = c.req.header("authorization");
      const bearerToken = authorization?.startsWith("Bearer ")
        ? authorization.slice(7).trim()
        : null;
      if (bearerToken) {
        const payload = await verifyProjectIngressToken(bearerToken);
        if (payload) {
          const user = await db.query.user.findFirst({
            where: (user, { eq }) => eq(user.id, payload.userId),
          });
          if (user) {
            const now = new Date();
            session = {
              session: {
                id: `ses_ingress_${user.id}`,
                expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
                token: bearerToken,
                ipAddress: c.req.header("cf-connecting-ip") ?? null,
                userAgent: c.req.header("user-agent") ?? null,
                userId: user.id,
                impersonatedBy: null,
                activeOrganizationId: null,
                createdAt: now,
                updatedAt: now,
              },
              user,
            } as AuthSession;
          }
        }
      }
    }
    const providedServiceToken = c.req.header("x-iterate-service-token")?.trim();
    const expectedServiceToken = c.env.SERVICE_AUTH_TOKEN?.trim();
    const serviceAuthorized = Boolean(
      expectedServiceToken && providedServiceToken === expectedServiceToken,
    );

    if (!session && serviceAuthorized) {
      const asUserId = c.req.header("x-iterate-as-user")?.trim();
      if (asUserId) {
        const user = await db.query.user.findFirst({
          where: (user, { eq }) => eq(user.id, asUserId),
        });
        if (user) {
          const now = new Date();
          session = {
            session: {
              id: `ses_as_user_${user.id}`,
              expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
              token: "",
              ipAddress: c.req.header("cf-connecting-ip") ?? null,
              userAgent: c.req.header("user-agent") ?? null,
              userId: user.id,
              impersonatedBy: null,
              activeOrganizationId: null,
              createdAt: now,
              updatedAt: now,
            },
            user,
          } as AuthSession;
        }
      }
    }

    c.set("session", session);
    c.set("db", db);
    c.set("serviceAuthorized", serviceAuthorized);
    return next();
  });
