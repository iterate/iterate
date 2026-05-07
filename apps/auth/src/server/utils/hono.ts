import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { AS_USER_HEADER, SERVICE_TOKEN_HEADER } from "@iterate-com/auth-contract";
import { parseBearerToken } from "@iterate-com/shared/bearer";
import { auth, type AuthSession, verifyProjectIngressToken } from "../auth.ts";
import { db, type DB } from "../db/index.ts";
import { parseBoolean, parseTimestampMs } from "../db/helpers.ts";
import { getUserById } from "../db/queries/.generated/index.ts";
import type { CloudflareEnv } from "../env.ts";

type ProjectIngressUser = NonNullable<AuthSession>["user"];

export type Variables = {
  db: DB;
  session: AuthSession;
  serviceAuthorized: boolean;
  projectIngressUser: ProjectIngressUser | null;
};

export const hono = () => new Hono<{ Bindings: CloudflareEnv; Variables: Variables }>();

function toAuthSessionUser(user: Awaited<ReturnType<typeof getUserById>>) {
  if (!user) return null;

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    emailVerified: parseBoolean(user.emailVerified),
    image: user.image ?? null,
    role: user.role ?? null,
    banned: parseBoolean(user.banned),
    banReason: user.banReason ?? null,
    banExpires: parseTimestampMs(user.banExpires),
    createdAt: new Date(user.createdAt),
    updatedAt: new Date(user.updatedAt),
  } satisfies ProjectIngressUser;
}

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
          const user = await getUserById(db, { id: payload.userId });
          const authUser = toAuthSessionUser(user);
          if (authUser) {
            projectIngressUser = authUser;
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
        const user = await getUserById(db, { id: asUserId });
        const authUser = toAuthSessionUser(user);
        if (authUser) {
          const now = new Date();
          session = {
            session: {
              id: `ses_as_user_${authUser.id}`,
              expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
              token: "",
              ipAddress: c.req.header("cf-connecting-ip") ?? null,
              userAgent: c.req.header("user-agent") ?? null,
              userId: authUser.id,
              impersonatedBy: null,
              activeOrganizationId: null,
              createdAt: now,
              updatedAt: now,
            },
            user: authUser,
          };
        }
      }
    }

    c.set("session", session);
    c.set("db", db);
    c.set("serviceAuthorized", serviceAuthorized);
    c.set("projectIngressUser", projectIngressUser);
    return next();
  });
