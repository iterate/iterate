export type PushNotificationData = {
  destination?: {
    kind?: string;
    path?: string;
    approvalRequestEventOffset?: number;
  };
  projectId?: string;
  requestOffset?: number;
};

export function pushNotificationRoute(data: PushNotificationData) {
  if (typeof data.projectId !== "string") return null;
  if (data.destination?.kind === "approvals") {
    if (typeof data.destination.approvalRequestEventOffset !== "number") return null;
    // The standalone Approvals screen is retired: batch pushes land on the
    // Notifications view, which pre-expands the matching row's detail.
    // `as const` is required: without it the property widens to `string`,
    // which expo-router's typed Href union rejects.
    return {
      pathname: "/project/[projectId]/notifications" as const,
      params: {
        projectId: data.projectId,
        approvalRequestEventOffset: String(data.destination.approvalRequestEventOffset),
      },
    };
  }
  if (data.destination?.kind === "agent-chat" && data.destination.path?.startsWith("/agents/")) {
    return {
      pathname: "/project/[projectId]/chat" as const,
      params: { projectId: data.projectId, path: data.destination.path },
    };
  }
  if (data.destination?.kind === "project") {
    return {
      pathname: "/project/[projectId]" as const,
      params: { projectId: data.projectId },
    };
  }
  return null;
}

export function notificationOpenedEvent(requestOffset: number, notificationDate: number) {
  return {
    type: "events.iterate.com/device/notification-opened" as const,
    idempotencyKey: `device-notification-opened:${requestOffset}`,
    payload: {
      openedAt: new Date(notificationDate).toISOString(),
      requestOffset,
    },
  };
}
