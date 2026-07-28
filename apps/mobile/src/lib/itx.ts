// The mobile binding for iterate/sdk/itx/react's renderer-agnostic session keeper.
// Deployment selection and OAuth token storage belong to the app; socket
// ownership, reconnects, liveness, project-stub caching, and the one forced
// credential refresh belong to the shared client.
import {
  configureIterateSession,
  connectIterateSession,
  connectItx,
  disconnectIterateSession,
  reconnectIterateSession,
  retryFailedIterateSession,
  type SessionStub,
} from "iterate/sdk/itx/react";
import { getAccessToken } from "./auth.ts";

export type ItxSession = SessionStub;

export function getItxSession(baseUrl: string): Promise<SessionStub> {
  configure(baseUrl);
  return connectIterateSession();
}

export function getProjectItx(baseUrl: string, projectId: string) {
  configure(baseUrl);
  return connectItx(projectId);
}

/** Re-authenticate on the selected deployment after credentials change. */
export function reconnectItxSession(baseUrl: string): void {
  configure(baseUrl);
  reconnectIterateSession();
}

/** Release all mobile itx authority at sign-out. */
export function disconnectItxSession(): void {
  disconnectIterateSession();
}

function configure(baseUrl: string): void {
  configureIterateSession({
    baseUrl,
    credentials: async ({ forceRefresh }) => ({
      type: "bearer",
      token: await getAccessToken(baseUrl, { forceRefresh }),
    }),
  });
  retryFailedIterateSession();
}
