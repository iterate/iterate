import {
  StreamProcessor,
  type ProcessorState,
  type StreamProcessorConstructorArgs,
} from "iterate/processors";
import type { z } from "zod";
import {
  DeviceNotificationDestination,
  DeviceNotificationOutcome,
  DeviceProcessorContract,
} from "./device-processor-contract.ts";

export type DevicePushMessage = {
  body: string;
  data: {
    destination: z.output<typeof DeviceNotificationDestination>;
    projectId: string;
    requestOffset: number;
  };
  expiresAt: number;
  title: string;
};

export type DevicePushSender = (input: {
  notification: DevicePushMessage;
  pushTokenSecretPath: string;
  pushTokenSecretUpdatedOffset: number;
}) => Promise<
  { status: "ok"; ticketId: string } | { status: "error"; error: string; message: string }
>;

type DevicePushReceipt =
  | { status: "pending" }
  | { status: "accepted-by-push-service" }
  | { status: "rejected-by-push-service"; error: string; message: string };

type DeviceProcessorDeps = {
  clearPushToken: (input: {
    pushTokenSecretPath: string;
    pushTokenSecretUpdatedOffset: number;
  }) => Promise<boolean>;
  getReceipt: (ticketId: string) => Promise<DevicePushReceipt>;
  now: () => number;
  repointReceiptAlarm: (atMs: number | null) => Promise<void>;
  send: DevicePushSender;
};

export class DeviceProcessor extends StreamProcessor<DeviceProcessorContract, DeviceProcessorDeps> {
  readonly contract = DeviceProcessorContract;
  readonly #liveAttempts = new Set<number>();

  constructor(args: StreamProcessorConstructorArgs<DeviceProcessorDeps>) {
    super(args);
  }

  protected override reduce({
    event,
    state,
  }: Parameters<StreamProcessor<DeviceProcessorContract>["reduce"]>[0]) {
    switch (event.type) {
      case "events.iterate.com/device/created":
        if (state.birthCertificate !== null) {
          throw new Error("device received more than one created event");
        }
        return {
          ...state,
          birthCertificate: event.payload,
          pushTokenSecretPath: event.payload.config.pushTokenSecretPath,
          pushTokenSecretUpdatedOffset: event.payload.config.pushTokenSecretUpdatedOffset,
          tokenUpdatedOffset: event.offset,
        };
      case "events.iterate.com/device/push-token-updated":
        return {
          ...state,
          birthCertificate:
            state.birthCertificate === null
              ? null
              : {
                  config: {
                    appVersion: event.payload.appVersion,
                    label: event.payload.label,
                    notificationsStatus: event.payload.notificationsStatus,
                    ownerId: event.payload.ownerId,
                    platform: state.birthCertificate.config.platform,
                    pushTokenSecretPath: event.payload.pushTokenSecretPath,
                    pushTokenSecretUpdatedOffset: event.payload.pushTokenSecretUpdatedOffset,
                  },
                },
          pushTokenSecretPath: event.payload.pushTokenSecretPath,
          pushTokenSecretUpdatedOffset: event.payload.pushTokenSecretUpdatedOffset,
          revokedAt: null,
          tokenUpdatedOffset: event.offset,
        };
      case "events.iterate.com/device/revoked":
        return {
          ...state,
          pushTokenSecretPath: null,
          pushTokenSecretUpdatedOffset: null,
          revokedAt: event.createdAt,
        };
      case "events.iterate.com/device/notification-requested":
      case "events.iterate.com/notification/requested":
        return {
          ...state,
          notifications: {
            ...state.notifications,
            [event.offset]: {
              body: event.payload.body,
              destination: event.payload.destination,
              expiresAt: event.payload.expiresAt,
              title: event.payload.title,
              status: "requested" as const,
            },
          },
        };
      case "events.iterate.com/device/notification-attempt-started": {
        const notification = state.notifications[event.payload.requestOffset];
        if (notification === undefined) return state;
        return {
          ...state,
          notifications: {
            ...state.notifications,
            [event.payload.requestOffset]: { ...notification, status: "started" as const },
          },
        };
      }
      case "events.iterate.com/device/notification-ticket-observed": {
        const notification = state.notifications[event.payload.requestOffset];
        if (notification === undefined) return state;
        return {
          ...state,
          notifications: {
            ...state.notifications,
            [event.payload.requestOffset]: {
              ...notification,
              status: "ticketed" as const,
              ticketId: event.payload.ticketId,
              ticketObservedAt: Date.parse(event.createdAt),
            },
          },
        };
      }
      case "events.iterate.com/device/notification-settled": {
        const notifications = { ...state.notifications };
        delete notifications[event.payload.requestOffset];
        return { ...state, notifications };
      }
      case "events.iterate.com/device/notification-opened":
        return { ...state, lastNotificationOpenedAt: event.payload.openedAt };
      default:
        return state;
    }
  }

  protected override processEvent(
    args: Parameters<StreamProcessor<DeviceProcessorContract>["processEvent"]>[0],
  ): undefined {
    const event = args.event;
    if (event?.type === "events.iterate.com/device/created") {
      args.blockProcessorWhile(() =>
        args.appendTo(
          "/",
          {
            type: "events.iterate.com/device/created",
            idempotencyKey: this.idempotencyKey("catalog-created", event),
            payload: event.payload,
          },
          notificationIntentCrossPost({
            idempotencyKey: this.idempotencyKey("notification-intent-cross-post", event),
            path: this.path,
          }),
        ),
      );
    }
    if (event?.type === "events.iterate.com/device/push-token-updated") {
      args.blockProcessorWhile(() =>
        args.appendTo(
          "/",
          notificationIntentCrossPost({
            idempotencyKey: this.idempotencyKey("notification-intent-cross-post", event),
            path: this.path,
          }),
        ),
      );
    }
    if (event?.type === "events.iterate.com/device/revoked") {
      args.blockProcessorWhile(() =>
        args.appendTo("/", {
          type: "events.iterate.com/stream/subscription-removed",
          idempotencyKey: this.idempotencyKey("notification-intent-cross-post-removed", event),
          payload: { subscriptionKey: `notification-intent:${this.path}` },
        }),
      );
    }
    if (!args.delivery.caughtUp || args.state.birthCertificate === null) return;
    const pushTokenSecretPath = args.state.pushTokenSecretPath;
    const settlements: {
      requestOffset: number;
      outcome: z.output<typeof DeviceNotificationOutcome>;
    }[] = [];
    for (const [offset, notification] of Object.entries(args.state.notifications)) {
      const requestOffset = Number(offset);
      if (notification.status === "requested" && notification.expiresAt <= this.deps.now()) {
        settlements.push({ requestOffset, outcome: { kind: "expired" } });
      } else if (notification.status === "requested" && pushTokenSecretPath === null) {
        settlements.push({ requestOffset, outcome: { kind: "device-unavailable" } });
      } else if (notification.status === "started" && !this.#liveAttempts.has(requestOffset)) {
        settlements.push({
          requestOffset,
          outcome: {
            kind: "uncertain",
            phase: "expo-send",
            reason:
              "The processor incarnation disappeared after recording the attempt start; Expo may have accepted the push, so it was not retried.",
          },
        });
      }
    }
    const nextReceiptCheck = Object.values(args.state.notifications)
      .filter(
        (notification) =>
          notification.status === "ticketed" && notification.ticketObservedAt !== undefined,
      )
      .reduce<number | null>((earliest, notification) => {
        const at = notification.ticketObservedAt! + 15 * 60_000;
        return earliest === null || at < earliest ? at : earliest;
      }, null);
    if (settlements.length > 0 || nextReceiptCheck !== null) {
      args.blockProcessorWhile(async () => {
        if (settlements.length > 0) {
          await this.append(
            ...settlements.map(({ outcome, requestOffset }) => ({
              type: "events.iterate.com/device/notification-settled" as const,
              idempotencyKey: this.idempotencyKey(`notification-settled@${requestOffset}`),
              payload: { requestOffset, outcome },
            })),
          );
        }
        if (nextReceiptCheck !== null) {
          await this.deps.repointReceiptAlarm(nextReceiptCheck);
        }
      });
    }
    const pushTokenSecretUpdatedOffset = args.state.pushTokenSecretUpdatedOffset;
    if (
      pushTokenSecretPath === null ||
      pushTokenSecretUpdatedOffset === null ||
      this.projectId === null
    )
      return;
    for (const [offset, notification] of Object.entries(args.state.notifications)) {
      const requestOffset = Number(offset);
      if (
        notification.status !== "requested" ||
        notification.expiresAt <= this.deps.now() ||
        this.#liveAttempts.has(requestOffset)
      ) {
        continue;
      }
      this.#liveAttempts.add(requestOffset);
      args.runInBackground(() =>
        this.#sendNotification({
          notification,
          pushTokenSecretPath,
          pushTokenSecretUpdatedOffset,
          requestOffset,
        }),
      );
    }
  }

  async checkReceipts(state: ProcessorState<DeviceProcessorContract>): Promise<void> {
    const now = this.deps.now();
    const settlements: {
      requestOffset: number;
      outcome: z.output<typeof DeviceNotificationOutcome>;
    }[] = [];
    let pushTokenInvalid = false;
    let nextCheckAt: number | null = null;
    for (const [offset, notification] of Object.entries(state.notifications)) {
      if (
        notification.status !== "ticketed" ||
        notification.ticketId === undefined ||
        notification.ticketObservedAt === undefined
      ) {
        continue;
      }
      const firstCheckAt = notification.ticketObservedAt + 15 * 60_000;
      if (now < firstCheckAt) {
        nextCheckAt = nextCheckAt === null ? firstCheckAt : Math.min(nextCheckAt, firstCheckAt);
        continue;
      }
      const receipt = await this.deps.getReceipt(notification.ticketId);
      const requestOffset = Number(offset);
      if (receipt.status === "accepted-by-push-service") {
        settlements.push({
          requestOffset,
          outcome: { kind: "accepted-by-push-service", ticketId: notification.ticketId },
        });
      } else if (receipt.status === "rejected-by-push-service") {
        pushTokenInvalid ||= receipt.error === "DeviceNotRegistered";
        settlements.push({
          requestOffset,
          outcome: {
            kind: "rejected-by-push-service",
            error: receipt.error,
            message: receipt.message,
            ticketId: notification.ticketId,
          },
        });
      } else if (now >= notification.ticketObservedAt + 24 * 60 * 60_000) {
        settlements.push({
          requestOffset,
          outcome: {
            kind: "uncertain",
            phase: "receipt",
            reason: "Expo did not produce a push receipt before its 24-hour retention window.",
          },
        });
      } else {
        const retryAt = now + 15 * 60_000;
        nextCheckAt = nextCheckAt === null ? retryAt : Math.min(nextCheckAt, retryAt);
      }
    }
    const pushTokenInvalidated =
      pushTokenInvalid && state.pushTokenSecretPath !== null
        ? await this.deps.clearPushToken({
            pushTokenSecretPath: state.pushTokenSecretPath,
            pushTokenSecretUpdatedOffset: state.pushTokenSecretUpdatedOffset!,
          })
        : false;
    if (pushTokenInvalid || settlements.length > 0) {
      await this.append(
        ...(pushTokenInvalidated
          ? [
              {
                type: "events.iterate.com/device/revoked" as const,
                idempotencyKey: this.idempotencyKey("push-token-invalid"),
                payload: { reason: "push-token-invalid" as const },
              },
            ]
          : []),
        ...settlements.map(({ outcome, requestOffset }) => ({
          type: "events.iterate.com/device/notification-settled" as const,
          idempotencyKey: this.idempotencyKey(`notification-settled@${requestOffset}`),
          payload: { requestOffset, outcome },
        })),
      );
    }
    await this.deps.repointReceiptAlarm(nextCheckAt);
  }

  async #sendNotification(input: {
    notification: ProcessorState<DeviceProcessorContract>["notifications"][string];
    pushTokenSecretPath: string;
    pushTokenSecretUpdatedOffset: number;
    requestOffset: number;
  }) {
    try {
      await this.append({
        type: "events.iterate.com/device/notification-attempt-started",
        idempotencyKey: this.idempotencyKey(`notification-attempt-started@${input.requestOffset}`),
        payload: { requestOffset: input.requestOffset },
      });
      const ticket = await this.deps.send({
        notification: {
          body: input.notification.body,
          data: {
            destination: input.notification.destination,
            projectId: this.projectId!,
            requestOffset: input.requestOffset,
          },
          expiresAt: input.notification.expiresAt,
          title: input.notification.title,
        },
        pushTokenSecretPath: input.pushTokenSecretPath,
        pushTokenSecretUpdatedOffset: input.pushTokenSecretUpdatedOffset,
      });
      if (ticket.status === "error") {
        const pushTokenInvalidated =
          ticket.error === "DeviceNotRegistered"
            ? await this.deps.clearPushToken({
                pushTokenSecretPath: input.pushTokenSecretPath,
                pushTokenSecretUpdatedOffset: input.pushTokenSecretUpdatedOffset,
              })
            : false;
        await this.append(
          ...(pushTokenInvalidated
            ? [
                {
                  type: "events.iterate.com/device/revoked" as const,
                  idempotencyKey: this.idempotencyKey("push-token-invalid"),
                  payload: { reason: "push-token-invalid" as const },
                },
              ]
            : []),
          {
            type: "events.iterate.com/device/notification-settled",
            idempotencyKey: this.idempotencyKey(`notification-settled@${input.requestOffset}`),
            payload: {
              requestOffset: input.requestOffset,
              outcome: {
                kind: "rejected-by-expo",
                error: ticket.error,
                message: ticket.message,
              },
            },
          },
        );
        return;
      }
      await this.append({
        type: "events.iterate.com/device/notification-ticket-observed",
        idempotencyKey: this.idempotencyKey(`notification-ticket-observed@${input.requestOffset}`),
        payload: { requestOffset: input.requestOffset, ticketId: ticket.ticketId },
      });
    } finally {
      this.#liveAttempts.delete(input.requestOffset);
    }
  }
}

function notificationIntentCrossPost(input: { idempotencyKey: string; path: string }) {
  return {
    type: "events.iterate.com/stream/subscription-configured" as const,
    idempotencyKey: input.idempotencyKey,
    payload: {
      subscriptionKey: `notification-intent:${input.path}`,
      description: `Copies project notification intents to ${input.path} for device-owned delivery.`,
      selector: { eventTypes: ["events.iterate.com/notification/requested"] },
      delivery: {
        mode: "push" as const,
        expression: ["streams", ["get", input.path], "acceptCrossPost"],
      },
      deliver: "new" as const,
    },
  };
}
