type DeliveryEvent = {
  createdAt: string;
  offset: number;
  payload?: Record<string, unknown>;
  type: string;
};

type DeliveryStream = {
  getEvents(input: { eventTypes: string[] }): Promise<DeliveryEvent[]>;
};

type DeliveryItx = {
  streams: { get(path: string): DeliveryStream };
};

/**
 * Preserve the UI failure, but add the durable event chain that owns it. A
 * timeout should say which transition is absent instead of only naming the
 * button or row that never rendered.
 */
export async function withApprovalDeliveryDiagnostic<Result>(input: {
  description: string;
  deviceId: string;
  itx: DeliveryItx;
  streamPaths: string[];
  wait: () => Promise<Result>;
}): Promise<Result> {
  try {
    return await input.wait();
  } catch (cause) {
    const diagnostic = await approvalDeliveryDiagnostic(input).catch(
      (diagnosticError: unknown) => ({
        diagnosticError:
          diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError),
      }),
    );
    throw new Error(
      `${input.description}\nApproval delivery diagnostic:\n${JSON.stringify(diagnostic, null, 2)}`,
      { cause },
    );
  }
}

async function approvalDeliveryDiagnostic(input: {
  deviceId: string;
  itx: DeliveryItx;
  streamPaths: string[];
}) {
  const scriptEventTypes = [
    "events.iterate.com/capability-host/script-run-requested",
    "events.iterate.com/capability-host/script-run-started",
    "events.iterate.com/capability-host/script-run-settled",
  ];
  const [rootEvents, deviceEvents, ...agentEvents] = await Promise.all([
    input.itx.streams.get("/").getEvents({
      eventTypes: [
        "events.iterate.com/project/human-approval-requested",
        "events.iterate.com/project/human-approval-decided",
        "events.iterate.com/notification/requested",
      ],
    }),
    input.itx.streams.get(`/devices/${input.deviceId}`).getEvents({
      eventTypes: [
        "events.iterate.com/notification/requested",
        "events.iterate.com/device/notification-attempt-started",
        "events.iterate.com/device/notification-settled",
      ],
    }),
    ...input.streamPaths.map((path) =>
      input.itx.streams.get(path).getEvents({ eventTypes: scriptEventTypes }),
    ),
  ]);

  return {
    deviceId: input.deviceId,
    streams: input.streamPaths.map((path, index) =>
      describeStreamDelivery({
        agentEvents: agentEvents[index]!,
        deviceEvents,
        path,
        rootEvents,
      }),
    ),
  };
}

function describeStreamDelivery(input: {
  agentEvents: DeliveryEvent[];
  deviceEvents: DeliveryEvent[];
  path: string;
  rootEvents: DeliveryEvent[];
}) {
  const requestedRuns = input.agentEvents.filter(
    (event) => event.type === "events.iterate.com/capability-host/script-run-requested",
  );
  if (requestedRuns.length === 0) {
    return { firstMissingTransition: "script-run-requested", path: input.path };
  }

  return {
    path: input.path,
    runs: requestedRuns.map((requested) => {
      const executionId = stringField(requested, "executionId");
      const started = findByExecutionId(
        input.agentEvents,
        "events.iterate.com/capability-host/script-run-started",
        executionId,
      );
      const settled = findByExecutionId(
        input.agentEvents,
        "events.iterate.com/capability-host/script-run-settled",
        executionId,
      );
      const approval = input.rootEvents.find((event) => {
        const context = event.payload?.streamContext;
        return (
          event.type === "events.iterate.com/project/human-approval-requested" &&
          typeof context === "object" &&
          context !== null &&
          "executionId" in context &&
          context.executionId === executionId
        );
      });
      const decision = input.rootEvents.find(
        (event) =>
          event.type === "events.iterate.com/project/human-approval-decided" &&
          numberField(event, "approvalRequestEventOffset") === approval?.offset,
      );
      const notification = input.rootEvents.find(
        (event) =>
          event.type === "events.iterate.com/notification/requested" &&
          numberField(event, "approvalRequestEventOffset") === approval?.offset,
      );
      const deviceNotification = input.deviceEvents.find(
        (event) =>
          event.type === "events.iterate.com/notification/requested" &&
          numberField(event, "approvalRequestEventOffset") === approval?.offset,
      );
      const firstMissingTransition =
        started === undefined
          ? "script-run-started"
          : approval === undefined
            ? settled === undefined
              ? "human-approval-requested (script still started)"
              : "human-approval-requested (script already settled)"
            : notification === undefined
              ? "notification/requested on project root"
              : deviceNotification === undefined
                ? "notification/requested copied to device"
                : "none; durable delivery is complete, so the UI projection failed to render";

      return {
        approvalRequestOffset: approval?.offset,
        decisionOffset: decision?.offset,
        deviceNotificationOffset: deviceNotification?.offset,
        executionId,
        firstMissingTransition,
        notificationOffset: notification?.offset,
        scriptRequestedOffset: requested.offset,
        scriptSettledOffset: settled?.offset,
        scriptSettlement: settled?.payload?.settlement,
        scriptStartedOffset: started?.offset,
      };
    }),
  };
}

function findByExecutionId(events: DeliveryEvent[], type: string, executionId: string | undefined) {
  return events.find(
    (event) => event.type === type && stringField(event, "executionId") === executionId,
  );
}

function stringField(event: DeliveryEvent, field: string): string | undefined {
  const value = event.payload?.[field];
  return typeof value === "string" ? value : undefined;
}

function numberField(event: DeliveryEvent, field: string): number | undefined {
  const value = event.payload?.[field];
  return typeof value === "number" ? value : undefined;
}
