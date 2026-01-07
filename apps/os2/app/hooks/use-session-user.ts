import { useSuspenseQuery } from "@tanstack/react-query";
import { sessionQueryOptions } from "../lib/session-query.ts";

export function useSessionUser() {
  const { data: session } = useSuspenseQuery(sessionQueryOptions());

  return {
    user: session?.user ?? null,
    session: session?.session ?? null,
    isAuthenticated: !!session?.user,
  };
}
