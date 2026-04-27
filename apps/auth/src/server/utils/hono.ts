import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { AS_USER_HEADER, SERVICE_TOKEN_HEADER } from "@iterate-com/auth-contract";
import { parseBearerToken } from "@iterate-com/shared/bearer";
import { auth, type AuthSession, verifyProjectIngressToken } from "../auth.ts";
import { db, type DB } from "../db/index.ts";
import type { CloudflareEnv } from "../env.ts";

type ProjectIngressUser = NonNullable<AuthSession>["user"];

export type Variables = {
  db: DB;
  session: AuthSession;
  serviceAuthorized: boolean;
  projectIngressUser: ProjectIngressUser | null;
};

export const hono = () => new Hono<{ Bindings: CloudflareEnv; Variables: Variables }>();

export const variablesProvider = () =>
  createMiddleware<{
    Variables: Variables;
    Bindings: CloudflareEnv;
  }>(async (c, next) => {
    let projectIngressUser: ProjectIngressUser | null = null;
    let session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) {
      const bearerToken = parseBearerToken(c.req.header("authorization"));
      if (bearerToken) {
        const payload = await verifyProjectIngressToken(bearerToken);
        if (payload) {
          const user = await db.query.user.findFirst({
            where: (user, { eq }) => eq(user.id, payload.userId),
          });
          if (user) {
            projectIngressUser = user;
          }
        }
      }
    }
    const providedServiceToken = c.req.header(SERVICE_TOKEN_HEADER)?.trim();
    const expectedServiceToken = c.env.SERVICE_AUTH_TOKEN?.trim();
    const serviceAuthorized = Boolean(
      expectedServiceToken && providedServiceToken === expectedServiceToken,
    );

    if (!session && serviceAuthorized) {
      const asUserId = c.req.header(AS_USER_HEADER)?.trim();
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
    c.set("projectIngressUser", projectIngressUser);
    return next();
  });
