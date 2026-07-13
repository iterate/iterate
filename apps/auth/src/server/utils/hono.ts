import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { SERVICE_TOKEN_HEADER } from "@iterate-com/auth-contract";
import { parseBearerToken } from "@iterate-com/shared/bearer";
import { auth, type AuthSession, verifyProjectIngressToken } from "../auth.ts";
import { db, type DB } from "../db/index.ts";
import { parseBoolean, parseTimestampMs } from "../db/helpers.ts";
import { getUserById } from "../db/queries/.generated/index.ts";
import { config, type CloudflareEnv } from "../env.ts";

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
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    const projectIngressUser = session
      ? null
      : await authenticateProjectIngressUser(c.req.header("authorization"));
    const serviceAuthorized = authenticateServiceRequest({
      expectedServiceToken: config.serviceAuthToken.exposeSecret(),
      providedServiceToken: c.req.header(SERVICE_TOKEN_HEADER),
    });

    c.set("session", session);
    c.set("db", db);
    c.set("serviceAuthorized", serviceAuthorized);
    c.set("projectIngressUser", projectIngressUser);
    return next();
  });

async function authenticateProjectIngressUser(authorizationHeader: string | undefined) {
  const bearerToken = parseBearerToken(authorizationHeader);
  if (!bearerToken) return null;

  const payload = await verifyProjectIngressToken(bearerToken);
  if (!payload) return null;

  return toAuthSessionUser(await getUserById(db, { id: payload.userId }));
}

function authenticateServiceRequest(input: {
  expectedServiceToken: string | undefined;
  providedServiceToken: string | undefined;
}) {
  const expectedServiceToken = input.expectedServiceToken?.trim();
  const providedServiceToken = input.providedServiceToken?.trim();
  return Boolean(expectedServiceToken && providedServiceToken === expectedServiceToken);
}
