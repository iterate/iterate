import { ORPCError } from "@orpc/server";
import { eq } from "drizzle-orm";
import { createIterateAuth } from "@iterate-com/auth/server";
import { parseBearerToken } from "@iterate-com/shared/bearer";
import * as schema from "../db/schema.ts";
import type { DB } from "../db/client.ts";
import type { CloudflareEnv } from "../../env.ts";
import { createAuthWorkerClient } from "../utils/auth-worker-client.ts";
import { logger } from "../tag-logger.ts";

type LocalUserRow = typeof schema.user.$inferSelect;
type SessionUser = LocalUserRow & {
  role: string | null;
};

export type MirroredAuthSession = {
  session: {
    id: string;
    expiresAt: Date;
    token: string;
    ipAddress: string | null;
    userAgent: string | null;
    userId: string;
    impersonatedBy: string | null;
    activeOrganizationId: string | null;
    createdAt: Date;
    updatedAt: Date;
  };
  user: SessionUser;
};

type IterateAuth = ReturnType<typeof createIterateAuth>;

const authInstances = new WeakMap<CloudflareEnv, IterateAuth>();

function isRecoverableBearerAuthFailure(error: unknown): boolean {
  return (
    error instanceof ORPCError &&
    (error.code === "UNAUTHORIZED" || error.code === "FORBIDDEN" || error.code === "BAD_REQUEST")
  );
}

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

function buildMirroredSession(params: {
  id: string;
  expiresAt: Date;
  userAgent: string | null;
  activeOrganizationId: string | null;
  user: SessionUser;
}): MirroredAuthSession {
  const now = new Date();
  return {
    session: {
      id: params.id,
      expiresAt: params.expiresAt,
      token: "",
      ipAddress: null,
      userAgent: params.userAgent,
      userId: params.user.id,
      impersonatedBy: null,
      activeOrganizationId: params.activeOrganizationId,
      createdAt: now,
      updatedAt: now,
    },
    user: params.user,
  };
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
  const userAgent = params.headers.get("user-agent");

  if (authenticated) {
    const localUser = await ensureLocalUserMirror(params.db, {
      id: authenticated.user.id,
      email: authenticated.user.email,
      name: authenticated.user.name ?? authenticated.user.email,
      image: authenticated.user.picture ?? null,
    });
    return {
      session: buildMirroredSession({
        id: authenticated.session.sessionId ?? `ses_auth_${localUser.id}`,
        expiresAt: new Date(authenticated.session.expiresAt * 1000),
        userAgent,
        activeOrganizationId: authenticated.session.activeOrganizationId ?? null,
        user: {
          ...localUser,
          role: authenticated.user.role ?? null,
        },
      }),
      responseHeaders,
    };
  }

  if (parseBearerToken(params.headers.get("authorization"))) {
    try {
      const authClient = createAuthWorkerClient({ headers: params.headers });
      const authUser = await authClient.user.me();
      const localUser = await ensureLocalUserMirror(params.db, {
        id: authUser.id,
        email: authUser.email,
        name: authUser.name,
        image: authUser.image,
      });
      return {
        session: buildMirroredSession({
          id: `ses_bearer_${localUser.id}`,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
          userAgent,
          activeOrganizationId: null,
          user: {
            ...localUser,
            role: authUser.role,
          },
        }),
        responseHeaders,
      };
    } catch (error) {
      if (isRecoverableBearerAuthFailure(error)) {
        logger.warn(`Bearer auth worker rejected request: ${String(error)}`);
        return { session: null, responseHeaders };
      }

      throw new ORPCError("INTERNAL_SERVER_ERROR", {
        message: "Bearer auth worker lookup failed",
        cause: error,
      });
    }
  }

  return { session: null, responseHeaders };
}

type AuthMirrorInput = {
  id: string;
  name: string;
  email: string;
  image: string | null;
};

export async function ensureLocalUserMirror(
  db: DB,
  authUser: AuthMirrorInput,
): Promise<LocalUserRow> {
  const normalizedEmail = authUser.email.trim().toLowerCase();
  const existingByAuthUserId = await db.query.user.findFirst({
    where: eq(schema.user.authUserId, authUser.id),
  });
  if (existingByAuthUserId) {
    if (
      existingByAuthUserId.email !== normalizedEmail ||
      existingByAuthUserId.name !== authUser.name ||
      existingByAuthUserId.image !== authUser.image ||
      existingByAuthUserId.emailVerified !== true
    ) {
      const [updated] = await db
        .update(schema.user)
        .set({
          email: normalizedEmail,
          name: authUser.name,
          image: authUser.image,
          emailVerified: true,
        })
        .where(eq(schema.user.id, existingByAuthUserId.id))
        .returning();

      return updated ?? existingByAuthUserId;
    }

    return existingByAuthUserId;
  }

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
    })
    .onConflictDoUpdate({
      target: schema.user.email,
      set: {
        authUserId: authUser.id,
        name: authUser.name,
        image: authUser.image,
      },
    })
    .returning();

  if (created) {
    return created;
  }

  throw new Error(`Failed to create local mirror user for ${authUser.email}`);
}
