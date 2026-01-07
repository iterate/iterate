import { queryOptions } from "@tanstack/react-query";
import { authClient } from "./auth-client.ts";

export const sessionQueryKey = ["auth", "session"] as const;

export type SessionData = Awaited<ReturnType<typeof fetchSession>>;

type ExtendedUser = { role?: string | null };
type ExtendedSession = { impersonatedBy?: string | null };

export async function fetchSession() {
  try {
    const result = await authClient.getSession();
    const session = result.data;
    if (!session) return null;

    const extendedUser = session.user as typeof session.user & ExtendedUser;
    const extendedSession = session.session as typeof session.session & ExtendedSession;

    return {
      user: {
        ...session.user,
        role: extendedUser.role,
      },
      session: {
        ...session.session,
        impersonatedBy: extendedSession.impersonatedBy,
      },
    };
  } catch {
    return null;
  }
}

export function sessionQueryOptions() {
  return queryOptions({
    queryKey: sessionQueryKey,
    queryFn: fetchSession,
  });
}
