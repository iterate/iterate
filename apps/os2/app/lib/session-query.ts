import { queryOptions } from "@tanstack/react-query";
import { authClient } from "./auth-client.ts";

export const sessionQueryKey = ["auth", "session"] as const;

export type SessionData = Awaited<ReturnType<typeof fetchSession>>;

export async function fetchSession() {
  try {
    const result = await authClient.getSession();
    const session = result.data;
    return session
      ? {
          user: {
            ...session.user,
            role: (session.user as any).role as string | null | undefined,
          },
          session: {
            ...session.session,
            impersonatedBy: (session.session as any).impersonatedBy as string | null | undefined,
          },
        }
      : null;
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
