import { useCallback, useMemo, useState, type ReactNode } from "react";
import { createIterateAuthClient, type SessionResponse } from "@iterate-com/auth/client";
import {
  AuthClientContext,
  type AuthClientContextValue,
  type OsSessionResponse,
} from "~/auth/client-context.ts";

const authClient = createIterateAuthClient();

export function AuthClientProvider({
  children,
  initialSession,
}: {
  children: ReactNode;
  initialSession: OsSessionResponse;
}) {
  const [session, setSession] = useState<OsSessionResponse | null>(initialSession);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setSession(toOsSessionResponse(await authClient.fetchSession()));
    } finally {
      setLoading(false);
    }
  }, []);

  const signIn = useCallback(() => {
    void authClient.login();
  }, []);

  const signOut = useCallback(async () => {
    await authClient.logout({
      global: true,
      returnTo: `${window.location.origin}/sign-in`,
    });
    setSession({ authenticated: false });
  }, []);

  const value = useMemo<AuthClientContextValue>(
    () => ({
      session,
      loading,
      refresh,
      signIn,
      signOut,
    }),
    [loading, refresh, session, signIn, signOut],
  );

  return <AuthClientContext.Provider value={value}>{children}</AuthClientContext.Provider>;
}

function toOsSessionResponse(session: SessionResponse): OsSessionResponse {
  if (!session.authenticated) {
    return { authenticated: false };
  }

  return {
    authenticated: true,
    user: session.user,
    session: session.session,
  };
}
