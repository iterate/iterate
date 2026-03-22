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
    async logout(): Promise<void> {
      await fetch(`${base}/logout`, { method: "POST", credentials: "include" });
    },
  };
}
