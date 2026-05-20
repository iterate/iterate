import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { createIterateAuthClient, type SessionResponse } from "@iterate-com/auth/client";
import { AuthClientContext, type AuthClientContextValue } from "~/auth/client-context.ts";

const authClient = createIterateAuthClient();

export function AuthClientProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setSession(await authClient.fetchSession());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo<AuthClientContextValue>(
    () => ({
      session,
      loading,
      refresh,
      signIn: () => void authClient.login(),
      signOut: async () => {
        await authClient.logout();
        setSession({ authenticated: false });
        window.location.href = "/sign-in";
      },
    }),
    [loading, refresh, session],
  );

  return <AuthClientContext.Provider value={value}>{children}</AuthClientContext.Provider>;
}
