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
import { AppState } from "react-native";
import { getAccessToken } from "./auth.ts";
import { getMobileDeviceId } from "./device-identity.ts";
import { MobileFetchCapabilities, MOBILE_FETCH_TYPES } from "./mobile-fetch.ts";
import { acknowledgeDeviceNotification } from "./notification-acknowledgement.ts";

export type ItxSession = SessionStub;

export async function getItxSession(baseUrl: string): Promise<SessionStub> {
  await configure(baseUrl);
  return connectIterateSession();
}

export async function getProjectItx(baseUrl: string, projectId: string) {
  await configure(baseUrl);
  return connectItx(projectId);
}

/** Shared by OS push taps and the same request's in-app notification row. */
export async function acknowledgeMobileNotification(input: {
  baseUrl: string;
  projectId: string;
  requestOffset: number;
  notificationDate: number;
}) {
  const session = await getItxSession(input.baseUrl);
  const project = session.projects.get(input.projectId);
  try {
    return await acknowledgeDeviceNotification({
      project,
      connect: () => getProjectItx(input.baseUrl, input.projectId),
      deviceId: await getMobileDeviceId(),
      requestOffset: input.requestOffset,
      notificationDate: input.notificationDate,
    });
  } finally {
    project[Symbol.dispose]();
  }
}

/** Re-authenticate on the selected deployment after credentials change. */
export async function reconnectItxSession(baseUrl: string): Promise<void> {
  await configure(baseUrl);
  reconnectIterateSession();
}

/** Release all mobile itx authority at sign-out. */
export function disconnectItxSession(): void {
  disconnectIterateSession();
}

async function configure(baseUrl: string): Promise<void> {
  const deviceId = await getMobileDeviceId();
  configureIterateSession({
    baseUrl,
    projectConnection: (session, projectId) =>
      session.projects.connect(projectId, {
        path: `/clients/mobile/${deviceId}`,
        description: "Foreground client HTTP fetch using this device's network connection.",
        capabilities: new MobileFetchCapabilities(fetch, () => AppState.currentState === "active"),
        types: MOBILE_FETCH_TYPES,
      }),
    credentials: async ({ forceRefresh }) => ({
      type: "bearer",
      token: await getAccessToken(baseUrl, { forceRefresh }),
    }),
  });
  retryFailedIterateSession();
}
