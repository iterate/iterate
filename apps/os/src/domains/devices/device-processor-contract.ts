import { z } from "zod";
import { defineProcessorContract, STREAM_PROCESSOR_REVIVED_EVENT_TYPE } from "iterate/processors";
import { NotificationDestination } from "../notifications/types.ts";
import { NotificationIntentContract } from "../notifications/notification-intent-contract.ts";
import { CoreProcessorContract } from "../streams/core-processor-contract.ts";

export const EncryptedDevicePushToken = z.strictObject({
  algorithm: z.literal("AES-GCM-SHA256+DEVICE-PUSH-V1"),
  ciphertext: z.string().trim().min(1),
  iv: z.string().trim().min(1),
});

const StoredEncryptedDevicePushToken = EncryptedDevicePushToken.extend({
  offset: z.number().int().positive(),
});

export const DeviceNotificationDestination = NotificationDestination;

const DeviceConfig = z.strictObject({
  appVersion: z.string().trim().min(1),
  label: z.string().trim().min(1),
  notificationsStatus: z.literal("granted"),
  ownerId: z.string().trim().min(1),
  platform: z.enum(["ios", "android"]),
});

const DeviceBirthCertificate = z.strictObject({
  config: z.union([
    DeviceConfig.extend({
      pushTokenSecretPath: z.string().trim().min(1),
      pushTokenSecretUpdatedOffset: z.number().int().positive(),
    }),
    DeviceConfig.extend({ encryptedPushToken: EncryptedDevicePushToken }),
  ]),
});

const DeviceNotificationRequest = z.strictObject({
  body: z.string().trim().min(1).max(4_000),
  destination: DeviceNotificationDestination,
  expiresAt: z.number().int().positive(),
  title: z.string().trim().min(1).max(200),
});

export const DeviceNotificationOutcome = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("expired") }),
  z.strictObject({ kind: z.literal("device-unavailable") }),
  z.strictObject({
    kind: z.literal("uncertain"),
    phase: z.enum(["expo-send", "receipt"]),
    reason: z.string().trim().min(1),
  }),
  z.strictObject({
    kind: z.literal("rejected-by-expo"),
    error: z.string().trim().min(1),
    message: z.string().trim().min(1),
  }),
  z.strictObject({ kind: z.literal("accepted-by-push-service"), ticketId: z.string() }),
  z.strictObject({
    kind: z.literal("rejected-by-push-service"),
    error: z.string().trim().min(1),
    message: z.string().trim().min(1),
    ticketId: z.string(),
  }),
]);

export const DeviceProcessorContract = defineProcessorContract({
  slug: "device",
  version: "0.2.0",
  description: "One enrolled installation and its durable push-notification obligations.",
  processorDeps: [CoreProcessorContract, NotificationIntentContract],
  stateSchema: z.object({
    birthCertificate: DeviceBirthCertificate.nullable().default(null),
    encryptedPushToken: StoredEncryptedDevicePushToken.nullable().default(null),
    pushTokenSecretPath: z.string().nullable().default(null),
    pushTokenSecretUpdatedOffset: z.number().int().positive().nullable().default(null),
    revokedAt: z.string().nullable().default(null),
    tokenUpdatedOffset: z.number().int().min(0).default(0),
    lastNotificationOpenedAt: z.string().nullable().default(null),
    notifications: z
      .record(
        z.string(),
        DeviceNotificationRequest.extend({
          status: z.enum(["requested", "started", "ticketed"]),
          ticketId: z.string().optional(),
          ticketObservedAt: z.number().int().positive().optional(),
        }),
      )
      .default({}),
  }),
  events: {
    "events.iterate.com/device/created": {
      description: "Birth certificate for one authenticated mobile installation.",
      payloadSchema: DeviceBirthCertificate,
    },
    "events.iterate.com/device/notification-requested": {
      description: "Requests one expiring push notification to this device.",
      payloadSchema: DeviceNotificationRequest,
    },
    "events.iterate.com/device/push-token-updated": {
      description: "Replaces the encrypted push credential and current app metadata.",
      payloadSchema: z.union([
        z.strictObject({
          appVersion: z.string().trim().min(1),
          label: z.string().trim().min(1),
          notificationsStatus: z.literal("granted"),
          ownerId: z.string().trim().min(1),
          pushTokenSecretPath: z.string().trim().min(1),
          pushTokenSecretUpdatedOffset: z.number().int().positive(),
        }),
        z.strictObject({
          appVersion: z.string().trim().min(1),
          encryptedPushToken: EncryptedDevicePushToken,
          label: z.string().trim().min(1),
          notificationsStatus: z.literal("granted"),
        }),
      ]),
    },
    "events.iterate.com/device/push-token-secret-linked": {
      description: "Completes bounded migration of a legacy encrypted device token into Secrets.",
      payloadSchema: z.strictObject({
        migratedFromOffset: z.number().int().positive(),
        pushTokenSecretPath: z.string().trim().min(1),
        pushTokenSecretUpdatedOffset: z.number().int().positive(),
      }),
    },
    "events.iterate.com/device/revoked": {
      description: "Revokes this installation and destroys its effective push credential.",
      payloadSchema: z.strictObject({
        reason: z.enum(["disabled", "permission-denied", "push-token-invalid", "sign-out"]),
      }),
    },
    "events.iterate.com/device/notification-attempt-started": {
      description: "Durable evidence written before invoking the push vendor.",
      payloadSchema: z.strictObject({ requestOffset: z.number().int().positive() }),
    },
    "events.iterate.com/device/notification-ticket-observed": {
      description: "Expo accepted the payload and returned a receipt ticket; this is not delivery.",
      payloadSchema: z.strictObject({
        requestOffset: z.number().int().positive(),
        ticketId: z.string().trim().min(1),
      }),
    },
    "events.iterate.com/device/notification-settled": {
      description:
        "Closes a notification obligation with an explicit vendor, expiry, or uncertain outcome.",
      payloadSchema: z.strictObject({
        outcome: DeviceNotificationOutcome,
        requestOffset: z.number().int().positive(),
      }),
    },
    "events.iterate.com/device/notification-opened": {
      description: "The app observed that the user opened a correlated notification.",
      payloadSchema: z.strictObject({
        openedAt: z.string().datetime(),
        requestOffset: z.number().int().positive(),
      }),
    },
  },
  consumes: [
    "events.iterate.com/device/created",
    "events.iterate.com/device/notification-requested",
    "events.iterate.com/notification/requested",
    "events.iterate.com/device/push-token-updated",
    "events.iterate.com/device/push-token-secret-linked",
    "events.iterate.com/device/revoked",
    "events.iterate.com/device/notification-attempt-started",
    "events.iterate.com/device/notification-ticket-observed",
    "events.iterate.com/device/notification-settled",
    "events.iterate.com/device/notification-opened",
    "events.iterate.com/stream/woken",
    "events.iterate.com/stream/subscriber-connected",
    STREAM_PROCESSOR_REVIVED_EVENT_TYPE,
  ],
  emits: [
    "events.iterate.com/device/created",
    "events.iterate.com/device/notification-attempt-started",
    "events.iterate.com/device/notification-ticket-observed",
    "events.iterate.com/device/notification-settled",
    "events.iterate.com/device/revoked",
    "events.iterate.com/device/push-token-secret-linked",
    "events.iterate.com/stream/subscription-configured",
    "events.iterate.com/stream/subscription-removed",
  ],
});

export type DeviceProcessorContract = typeof DeviceProcessorContract;
