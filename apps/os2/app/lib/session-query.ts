import { queryOptions } from "@tanstack/react-query";
import { authClient } from "./auth-client.ts";

export const sessionQueryKey = ["auth", "session"] as const;

export async function fetchSession() {
  try {
    return await authClient.getSession();
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
