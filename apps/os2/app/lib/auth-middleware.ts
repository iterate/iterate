import { redirect } from "@tanstack/react-router";
import { createMiddleware } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { getAuth } from "../../backend/auth/auth.ts";
import { getDb } from "../../backend/db/client.ts";
import type { AuthSession } from "../../backend/auth/auth.ts";

export const authMiddleware = createMiddleware().server(async ({ next }) => {
  const headers = getRequestHeaders();
  const db = getDb();
  const auth = getAuth(db);
  const sessionResult = await auth.api.getSession({ headers });
  const sessionData = unwrapSessionResult(sessionResult);

  if (!sessionData?.user || !sessionData.session) {
    throw redirect({ to: "/login" });
  }

  return next({
    context: {
      session: sessionData,
      user: sessionData.user,
    },
  });
});

type SessionData = NonNullable<AuthSession>;

type SessionResult = AuthSession | { data: AuthSession | null } | null | undefined;

function unwrapSessionResult(sessionResult: SessionResult): AuthSession {
  if (sessionResult && typeof sessionResult === "object" && "data" in sessionResult) {
    return sessionResult.data ?? null;
  }

  return sessionResult ?? null;
}
