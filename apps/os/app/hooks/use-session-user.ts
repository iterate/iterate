import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "../lib/trpc.ts";

export function useSessionUser() {
  const trpc = useTRPC();
  const userQuery = useQuery(
    trpc.user.me.queryOptions(void 0, {
      staleTime: 1000 * 60 * 10,
    }),
  );
  if (!userQuery.data)
    throw new Error(
      `User data not found, either this route doesn't guarantee authentication or user data wasn't preloaded`,
    );
  return userQuery.data;
}
