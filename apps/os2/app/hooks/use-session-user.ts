import { useSuspenseQuery } from "@tanstack/react-query";
import { trpc } from "../lib/trpc.tsx";

export function useSessionUser() {
  const { data: user } = useSuspenseQuery(trpc.user.me.queryOptions());

  return {
    user,
    isAuthenticated: !!user,
  };
}
