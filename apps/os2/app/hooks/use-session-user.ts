import { useSession } from "../lib/auth-client.ts";

export function useSessionUser() {
  const { data: session, isPending, error } = useSession();

  return {
    user: session?.user ?? null,
    session: session?.session ?? null,
    isLoading: isPending,
    error,
    isAuthenticated: !!session?.user,
  };
}
