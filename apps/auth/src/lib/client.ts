import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { SessionResponse } from "./server.ts";
export type {
  AuthenticateResult,
  AuthenticatedSession,
  AuthSession,
  AuthUser,
  SessionResponse,
} from "./server.ts";

export type PublicSessionResponse =
  | { authenticated: false }
  | Pick<Extract<SessionResponse, { authenticated: true }>, "authenticated" | "session" | "user">;

type IterateAuthClientConfig = {
  /** Base path where the auth handler is mounted, e.g. "/api/iterate-auth" (Default) */
  authHandlerBasePath?: string;
};

type LogoutOptions = {
  /**
   * Also sign out of the upstream auth server. This must use browser navigation
   * so the auth server can clear its own HttpOnly cookies.
   */
  global?: boolean;
  /** Destination after logout. Defaults to the current origin. */
  returnTo?: string;
};

type LoginOptions = {
  /** Destination after OAuth callback. Defaults to the current origin. */
  returnTo?: string;
  /** Preferred sign-in method for the auth server login page. */
  loginHint?: "email" | "google";
};

type RefreshOptions = {
  /** Reissue the OAuth access token even when it is not near expiry. */
  force?: boolean;
};

export type AuthClient = ReturnType<typeof createIterateAuthClient>;

export type AuthClientContextValue = {
  session: PublicSessionResponse | null;
  loading: boolean;
  signIn: (options?: LoginOptions) => void;
  signOut: () => Promise<void>;
  refresh: (options?: RefreshOptions) => Promise<void>;
};

export type AuthClientProviderProps = {
  children: ReactNode;
  client?: AuthClient;
  initialSession: PublicSessionResponse;
  globalSignOut?: boolean;
  signOutReturnTo?: string | (() => string);
};

const AuthClientContext = createContext<AuthClientContextValue | null>(null);

export function createIterateAuthClient(config: IterateAuthClientConfig = {}) {
  const base = (config.authHandlerBasePath ?? "/api/iterate-auth").replace(/\/$/, "");

  async function fetchSession(options: RefreshOptions = {}): Promise<SessionResponse> {
    const url = options.force ? `${base}/session?refresh=force` : `${base}/session`;

    const response = await fetch(url, {
      credentials: "include",
      headers: { Accept: "application/json" },
    });

    if (!response.ok) return { authenticated: false };

    return (await response.json()) as SessionResponse;
  }

  return {
    async login(options: LoginOptions = {}): Promise<void> {
      const url = new URL(`${base}/login`, window.location.origin);
      if (options.returnTo) {
        url.searchParams.set("return_to", options.returnTo);
      }
      if (options.loginHint) {
        url.searchParams.set("login_hint", options.loginHint);
      }
      window.location.href = url.toString();
    },
    fetchSession,
    async logout(options: LogoutOptions = {}): Promise<void> {
      if (options.global) {
        const returnTo = options.returnTo ?? window.location.origin;
        window.location.href = `${base}/logout?return_to=${encodeURIComponent(returnTo)}`;
        return;
      }

      await fetch(`${base}/logout`, { method: "POST", credentials: "include" });
    },
  };
}

const defaultAuthClient = createIterateAuthClient();

export function AuthClientProvider({
  children,
  client = defaultAuthClient,
  globalSignOut = true,
  initialSession,
  signOutReturnTo = () => `${window.location.origin}/sign-in`,
}: AuthClientProviderProps) {
  const [session, setSession] = useState<PublicSessionResponse | null>(initialSession);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(
    async (options: RefreshOptions = {}) => {
      setLoading(true);
      try {
        setSession(toPublicSessionResponse(await client.fetchSession(options)));
      } finally {
        setLoading(false);
      }
    },
    [client],
  );

  const signIn = useCallback(
    (options: LoginOptions = {}) => {
      void client.login(options);
    },
    [client],
  );

  const signOut = useCallback(async () => {
    await client.logout({
      global: globalSignOut,
      returnTo: typeof signOutReturnTo === "function" ? signOutReturnTo() : signOutReturnTo,
    });
    setSession({ authenticated: false });
  }, [client, globalSignOut, signOutReturnTo]);

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

  return createElement(AuthClientContext.Provider, { value }, children);
}

export function useAuthClient() {
  const value = useContext(AuthClientContext);
  if (!value) {
    throw new Error("useAuthClient must be used within AuthClientProvider.");
  }
  return value;
}

export function toPublicSessionResponse(session: SessionResponse): PublicSessionResponse {
  if (!session.authenticated) {
    return { authenticated: false };
  }

  return {
    authenticated: true,
    user: session.user,
    session: session.session,
  };
}
