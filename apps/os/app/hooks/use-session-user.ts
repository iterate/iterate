import { useSuspenseQuery } from "@tanstack/react-query";
import { orpc } from "../lib/orpc.tsx";

export function useSessionUser() {
  const { data: user } = useSuspenseQuery(orpc.user.me.queryOptions());

  return {
    user,
    isAuthenticated: !!user,
  };
}
