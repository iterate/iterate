import type { SessionResponse } from "./server.ts";
export type {
  AuthenticateResult,
  AuthenticatedSession,
  AuthSession,
  AuthUser,
  SessionResponse,
} from "./server.ts";

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

export function createIterateAuthClient(config: IterateAuthClientConfig = {}) {
  const base = (config.authHandlerBasePath ?? "/api/iterate-auth").replace(/\/$/, "");

  async function fetchSession(): Promise<SessionResponse> {
    const response = await fetch(`${base}/session`, {
      credentials: "include",
      headers: { Accept: "application/json" },
    });

    if (!response.ok) return { authenticated: false };

    return (await response.json()) as SessionResponse;
  }

  return {
    async login(): Promise<void> {
      window.location.href = `${base}/login`;
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
