import { eq } from "drizzle-orm";
import { createIterateAuth } from "@iterate-com/auth/server";
import * as schema from "../db/schema.ts";
import type { DB } from "../db/client.ts";
import type { CloudflareEnv } from "../../env.ts";
import { createAuthWorkerClient } from "../utils/auth-worker-client.ts";
import { logger } from "../tag-logger.ts";

type LocalSessionUser = typeof schema.user.$inferSelect;

export type MirroredAuthSession = {
  session: {
    id: string;
    expiresAt: Date;
    token: string;
    ipAddress: string | null;
    userAgent: string | null;
    userId: string;
    impersonatedBy: string | null;
    createdAt: Date;
    updatedAt: Date;
  };
  user: LocalSessionUser;
};

type IterateAuth = ReturnType<typeof createIterateAuth>;

const authInstances = new WeakMap<CloudflareEnv, IterateAuth>();

export function getOsIterateAuth(env: CloudflareEnv): IterateAuth {
  const cached = authInstances.get(env);
  if (cached) return cached;

  const { ITERATE_OAUTH_CLIENT_ID, ITERATE_OAUTH_CLIENT_SECRET, ITERATE_OAUTH_REDIRECT_URI } = env;
  if (!ITERATE_OAUTH_CLIENT_ID || !ITERATE_OAUTH_CLIENT_SECRET || !ITERATE_OAUTH_REDIRECT_URI) {
    throw new Error(
      "OS is missing OAuth client configuration (ITERATE_OAUTH_CLIENT_ID / SECRET / REDIRECT_URI).",
    );
  }

  const instance = createIterateAuth({
    issuer: env.ITERATE_OAUTH_ISSUER,
    clientId: ITERATE_OAUTH_CLIENT_ID,
    clientSecret: ITERATE_OAUTH_CLIENT_SECRET,
    redirectURI: ITERATE_OAUTH_REDIRECT_URI,
  });
  authInstances.set(env, instance);
  return instance;
}

export async function getOAuthMirroredSession(params: {
  db: DB;
  env: CloudflareEnv;
  headers: Headers;
}): Promise<{ session: MirroredAuthSession | null; responseHeaders: Headers }> {
  const iterateAuth = getOsIterateAuth(params.env);
  const { session: authenticated, responseHeaders } = await iterateAuth.authenticate({
    headers: params.headers,
  });
  if (authenticated) {
    const localUser = await ensureLocalUserMirror(params.db, {
      id: authenticated.user.id,
      email: authenticated.user.email,
      name: authenticated.user.name ?? authenticated.user.email,
      image: authenticated.user.picture ?? null,
      role: null,
    });
    const now = new Date();

    return {
      session: {
        session: {
          id: authenticated.session.sessionId ?? `ses_auth_${localUser.id}`,
          expiresAt: new Date(authenticated.session.expiresAt * 1000),
          token: "",
          ipAddress: null,
          userAgent: params.headers.get("user-agent"),
          userId: localUser.id,
          impersonatedBy: null,
          createdAt: now,
          updatedAt: now,
        },
        user: localUser,
      },
      responseHeaders,
    };
  }

  const bearer = params.headers.get("authorization");
  if (bearer?.toLowerCase().startsWith("bearer ")) {
    try {
      const authClient = createAuthWorkerClient({ headers: params.headers });
      const authUser = await authClient.user.me();
      const localUser = await ensureLocalUserMirror(params.db, {
        id: authUser.id,
        email: authUser.email,
        name: authUser.name,
        image: authUser.image,
        role: authUser.role,
      });
      const now = new Date();
      return {
        session: {
          session: {
            id: `ses_bearer_${localUser.id}`,
            expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
            token: "",
            ipAddress: null,
            userAgent: params.headers.get("user-agent"),
            userId: localUser.id,
            impersonatedBy: null,
            createdAt: now,
            updatedAt: now,
          },
          user: localUser,
        },
        responseHeaders,
      };
    } catch (error) {
      logger.warn(`Bearer auth worker lookup failed: ${String(error)}`);
    }
  }

  return { session: null, responseHeaders };
}

type AuthMirrorInput = {
  id: string;
  name: string;
  email: string;
  image: string | null;
  role: string | null;
};

export async function ensureLocalUserMirror(
  db: DB,
  authUser: AuthMirrorInput,
): Promise<LocalSessionUser> {
  const existingByAuthUserId = await db.query.user.findFirst({
    where: eq(schema.user.authUserId, authUser.id),
  });
  if (existingByAuthUserId) {
    return existingByAuthUserId;
  }

  const normalizedEmail = authUser.email.trim().toLowerCase();
  const existingByEmail = await db.query.user.findFirst({
    where: eq(schema.user.email, normalizedEmail),
  });
  if (existingByEmail) {
    const [updated] = await db
      .update(schema.user)
      .set({
        authUserId: authUser.id,
        name: authUser.name,
        image: authUser.image,
        role: authUser.role ?? existingByEmail.role ?? "user",
      })
      .where(eq(schema.user.id, existingByEmail.id))
      .returning();

    return updated ?? existingByEmail;
  }

  const [created] = await db
    .insert(schema.user)
    .values({
      authUserId: authUser.id,
      name: authUser.name,
      email: normalizedEmail,
      emailVerified: true,
      image: authUser.image,
      role: authUser.role ?? "user",
    })
    .onConflictDoUpdate({
      target: schema.user.email,
      set: {
        authUserId: authUser.id,
        name: authUser.name,
        image: authUser.image,
        role: authUser.role ?? "user",
      },
    })
    .returning();

  if (created) {
    return created;
  }

  throw new Error(`Failed to create local mirror user for ${authUser.email}`);
}
