import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { createIterateAuthClient, type SessionResponse } from "@iterate-com/auth/client";

type AuthClientContextValue = {
  session: SessionResponse | null;
  loading: boolean;
  signIn: () => void;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
};

const authClient = createIterateAuthClient();
const AuthClientContext = createContext<AuthClientContextValue | null>(null);

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

export function useAuthClient() {
  const value = useContext(AuthClientContext);
  if (!value) {
    throw new Error("useAuthClient must be used within AuthClientProvider.");
  }
  return value;
}
