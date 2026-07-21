// The device processor CONTRACT. Self-contained: state schema, events,
// consumes/emits, deps — and it OWNS every nested data structure (the birth
// certificate, the notification request, the settlement outcome union);
// consumers reach into this module for pieces, never the other way around.
// Schemas are spelled INLINE in the contract; the two it needs twice (the
// birth certificate, the notification request) are hoisted functions defined
// below the contract, so the contract still opens the file. The one
// cross-domain shape — the notification DESTINATION — is reached through the
// notification-intent contract that owns it, because a device reduces
// cross-posted `notification/requested` intents straight into its own state:
// if the two unions drifted, intents would stop reducing.
//
// Push credentials never appear on this stream: the Expo push token lives in
// a write-only Secret (PR #2149), and every event carries only the Secret's
// path plus its update offset — a compare-and-clear revision, so a stale
// vendor rejection can never erase a credential rotated while the rejection
// was in flight.

import { z } from "zod";
import { defineProcessorContract } from "iterate/processors";
import { NotificationIntentContract } from "../notifications/notification-intent-contract.ts";
import { CoreProcessorContract } from "../streams/core-processor-contract.ts";

export const DeviceProcessorContract = defineProcessorContract({
  slug: "device",
  // 0.3.0: tuning knobs moved into state.config (schema defaults only — no
  // configured event); reducer semantics are unchanged, the bump just refolds
  // checkpoints into the new shape.
  version: "0.3.0",
  description: "One enrolled installation and its durable push-notification obligations.",
  processorDeps: [CoreProcessorContract, NotificationIntentContract],
  stateSchema: z.object({
    birthCertificate: deviceBirthCertificateSchema()
      .nullable()
      .default(null)
      .meta({
        description:
          "Existence marker: null until device/created reduces. Holds the CURRENT enrollment " +
          "config — push-token-updated replaces every field except the immutable platform — " +
          "and survives revocation, so a revoked device still describes itself.",
      }),
    config: z
      .object({
        receiptCheckDelayMs: z
          .number()
          .int()
          .positive()
          .default(15 * 60_000)
          .meta({
            description:
              "How long after a ticket is observed before its Expo receipt is first checked, " +
              "and the re-check spacing while a receipt stays pending. 15 minutes because " +
              "Expo's docs say receipts typically materialize within that window — checking " +
              "earlier mostly burns receipt-API calls on pending answers.",
          }),
        receiptRetentionMs: z
          .number()
          .int()
          .positive()
          .default(24 * 60 * 60_000)
          .meta({
            description:
              "How long a ticketed notification waits for a receipt before settling " +
              "uncertain. 24 hours because that is Expo's receipt retention window — past " +
              "it the outcome is permanently unknowable.",
          }),
      })
      .prefault({})
      .meta({
        description:
          "Receipt-polling knobs, every value defaulted by the schema (no configured event " +
          "— nothing here needs runtime configuration yet).",
      }),
    pushTokenSecretPath: z
      .string()
      .nullable()
      .default(null)
      .meta({
        description:
          "Stream path of the write-only Secret holding the CURRENT Expo push token, or null " +
          "once revoked — the send gate: no path, no attempts.",
      }),
    pushTokenSecretUpdatedOffset: z
      .number()
      .int()
      .positive()
      .nullable()
      .default(null)
      .meta({
        description:
          "The Secret's update offset for the current credential. Every send and every " +
          "compare-and-clear is fenced on it, so an invalid-token response for an OLDER Expo " +
          "request cannot erase Secret material rotated while that request was in flight.",
      }),
    revokedAt: z
      .string()
      .nullable()
      .default(null)
      .meta({
        description:
          "ISO timestamp of the newest device/revoked fact, or null while enrolled. A " +
          "push-token-updated re-enrollment clears it.",
      }),
    tokenUpdatedOffset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .meta({
        description:
          "Offset of the newest created/push-token-updated fact — the credential revision. " +
          "The device Durable Object keys revocation appends on it, so revoking twice for the " +
          "same credential dedupes while a re-enrolled credential can be revoked afresh.",
      }),
    lastNotificationOpenedAt: z
      .string()
      .nullable()
      .default(null)
      .meta({
        description:
          "ISO timestamp of the newest notification-opened fact — the engagement signal the " +
          "dashboard shows.",
      }),
    notifications: z
      .record(
        z.string(),
        deviceNotificationRequestSchema()
          .extend({
            status: z.enum(["requested", "started", "ticketed"]).meta({
              description:
                "The obligation's phase: requested (no attempt yet) → started " +
                "(attempt-started reduced — Expo may already know) → ticketed (Expo " +
                "returned a receipt ticket).",
            }),
            ticketId: z.string().optional().meta({
              description: "Expo's receipt ticket id, present once status is ticketed.",
            }),
            ticketObservedAt: z
              .number()
              .int()
              .positive()
              .optional()
              .meta({
                description:
                  "Epoch ms the ticket-observed fact committed (its createdAt) — anchors the " +
                  "receipt-check schedule.",
              }),
          })
          .meta({ description: "One open push obligation and how far its attempt has gone." }),
      )
      .default({})
      .meta({
        description:
          "Open notification obligations keyed by the STRINGIFIED OFFSET of the requesting " +
          "event — the request's identity, no synthetic ids anywhere. A terminal " +
          "notification-settled fact deletes its entry; whatever remains is owed work the " +
          "at-head pass drives.",
      }),
  }),
  events: {
    "events.iterate.com/device/created": {
      description:
        "Birth certificate for one authenticated mobile installation. The processor " +
        "cross-posts this fact to the project root stream (catalog) and configures the " +
        "notification-intent subscription that copies project-level notification/requested " +
        "intents onto this device stream.",
      payloadSchema: deviceBirthCertificateSchema(),
      examples: [
        {
          description: "An iPhone enrolls after the user grants notification permission.",
          payload: {
            config: {
              appVersion: "2.4.0",
              label: "Misha's iPhone",
              notificationsStatus: "granted",
              ownerId: "usr_01HZX3K9M2",
              platform: "ios",
              pushTokenSecretPath: "/secrets/devices/dvc_3f8a/expo-push-token",
              pushTokenSecretUpdatedOffset: 4,
            },
          },
        },
      ],
    },
    "events.iterate.com/device/notification-requested": {
      description:
        "Requests one expiring push notification to this device. The event's own offset is " +
        "the obligation's identity; every later fact points back with requestOffset.",
      payloadSchema: deviceNotificationRequestSchema(),
      examples: [
        {
          description: "An approval request pushes to the phone with a five-minute deadline.",
          payload: {
            body: "POST api.stripe.com is waiting for your approval.",
            destination: { kind: "approvals", approvalRequestEventOffset: 17 },
            expiresAt: 1784536200000,
            title: "Approval needed",
          },
        },
      ],
    },
    "events.iterate.com/device/push-token-updated": {
      description:
        "Replaces the Secret-backed push credential and current app metadata (re-enrollment: " +
        "it also clears a standing revocation). The platform is immutable and stays what the " +
        "birth certificate said.",
      payloadSchema: z.strictObject({
        appVersion: z
          .string()
          .trim()
          .min(1)
          .meta({ description: "App build the installation reports now." }),
        label: z
          .string()
          .trim()
          .min(1)
          .meta({ description: "Human-readable device name shown in the dashboard." }),
        notificationsStatus: z.literal("granted").meta({
          description:
            "OS notification permission; a token update only happens while it is granted " +
            "(denial goes through device/revoked instead).",
        }),
        ownerId: z
          .string()
          .trim()
          .min(1)
          .meta({ description: "The authenticated user this installation belongs to." }),
        pushTokenSecretPath: z
          .string()
          .trim()
          .min(1)
          .meta({
            description:
              "Stream path of the write-only Secret now holding the Expo push token — the " +
              "token itself never rides this stream.",
          }),
        pushTokenSecretUpdatedOffset: z
          .number()
          .int()
          .positive()
          .meta({
            description:
              "The Secret's update offset for the new material — the compare-and-clear " +
              "revision every send and clear is fenced on.",
          }),
      }),
      examples: [
        {
          description: "The app rotates its Expo token after an OS update.",
          payload: {
            appVersion: "2.5.1",
            label: "Misha's iPhone",
            notificationsStatus: "granted",
            ownerId: "usr_01HZX3K9M2",
            pushTokenSecretPath: "/secrets/devices/dvc_3f8a/expo-push-token",
            pushTokenSecretUpdatedOffset: 9,
          },
        },
      ],
    },
    "events.iterate.com/device/revoked": {
      description:
        "Revokes this installation: the effective push credential is destroyed (the Secret " +
        "material was compare-and-cleared before this fact) and the notification-intent " +
        "subscription is removed. Requests arriving afterwards settle device-unavailable.",
      payloadSchema: z.strictObject({
        reason: z.enum(["disabled", "permission-denied", "push-token-invalid", "sign-out"]).meta({
          description:
            "Why the device was revoked: disabled (user toggle), permission-denied (OS " +
            "permission withdrawn), push-token-invalid (the push service reported " +
            "DeviceNotRegistered), sign-out.",
        }),
      }),
      examples: [
        { description: "The user signs out of the app.", payload: { reason: "sign-out" } },
        {
          description:
            "Expo reported DeviceNotRegistered, so the processor cleared the credential and revoked itself.",
          payload: { reason: "push-token-invalid" },
        },
      ],
    },
    "events.iterate.com/device/notification-attempt-started": {
      description:
        "Durable evidence written BEFORE invoking the push vendor. If an incarnation dies " +
        "between this fact and a ticket, the obligation settles uncertain instead of being " +
        "retried — Expo may already have accepted the push.",
      payloadSchema: z.strictObject({
        requestOffset: z.number().int().positive().meta({
          description: "The obligation being attempted: the offset of its requesting event.",
        }),
      }),
      examples: [
        {
          description: "The processor is about to dial Expo for the request at offset 12.",
          payload: { requestOffset: 12 },
        },
      ],
    },
    "events.iterate.com/device/notification-ticket-observed": {
      description:
        "Expo accepted the payload and returned a receipt ticket. This is NOT delivery — " +
        "the receipt check later resolves what the underlying push service (APNs/FCM) did.",
      payloadSchema: z.strictObject({
        requestOffset: z.number().int().positive().meta({
          description: "The obligation the ticket belongs to: the offset of its requesting event.",
        }),
        ticketId: z
          .string()
          .trim()
          .min(1)
          .meta({ description: "Expo's receipt ticket id, polled later for the outcome." }),
      }),
      examples: [
        {
          description: "Expo queued the push and handed back a ticket.",
          payload: { requestOffset: 12, ticketId: "0f38e7d2-6a4b-4c8e-9f3a-2b1d5e7c9a01" },
        },
      ],
    },
    "events.iterate.com/device/notification-settled": {
      description:
        "The ONE terminal fact for a notification obligation, pointing back at the " +
        "requesting event's offset. Idempotency-keyed on that offset, so the expiry sweep, " +
        "the send path, and the receipt check collapse to one settlement.",
      payloadSchema: z.strictObject({
        outcome: z
          .discriminatedUnion("kind", [
            z.strictObject({
              kind: z.literal("expired").meta({
                description: "The request outlived its expiresAt before any attempt started.",
              }),
            }),
            z.strictObject({
              kind: z.literal("device-unavailable").meta({
                description:
                  "The device has no push credential (revoked, or the token was cleared), " +
                  "so no attempt is possible.",
              }),
            }),
            z.strictObject({
              kind: z.literal("uncertain").meta({
                description:
                  "The truth is unknowable and the push was deliberately NOT retried (it " +
                  "may have reached the user once already).",
              }),
              phase: z.enum(["expo-send", "receipt"]).meta({
                description:
                  "Where certainty was lost: expo-send (the incarnation died between " +
                  "attempt-started and Expo's answer) or receipt (Expo's retention window " +
                  "lapsed with the receipt still pending).",
              }),
              reason: z
                .string()
                .trim()
                .min(1)
                .meta({ description: "Human-readable account of why the outcome is unknowable." }),
            }),
            z.strictObject({
              kind: z.literal("rejected-by-expo").meta({
                description: "Expo's send API refused the push (e.g. DeviceNotRegistered).",
              }),
              error: z
                .string()
                .trim()
                .min(1)
                .meta({ description: "Expo's machine-readable error code." }),
              message: z
                .string()
                .trim()
                .min(1)
                .meta({ description: "Expo's human-readable error message." }),
            }),
            z.strictObject({
              kind: z.literal("accepted-by-push-service").meta({
                description:
                  "The receipt says APNs/FCM accepted the push — the strongest signal " +
                  "available; actual on-device display is never observable.",
              }),
              ticketId: z.string().meta({ description: "The receipt ticket that resolved." }),
            }),
            z.strictObject({
              kind: z.literal("rejected-by-push-service").meta({
                description: "The receipt says APNs/FCM refused the push.",
              }),
              error: z
                .string()
                .trim()
                .min(1)
                .meta({ description: "The push service's error code (e.g. DeviceNotRegistered)." }),
              message: z
                .string()
                .trim()
                .min(1)
                .meta({ description: "The push service's human-readable error message." }),
              ticketId: z.string().meta({ description: "The receipt ticket that resolved." }),
            }),
          ])
          .meta({ description: "How the obligation settled." }),
        requestOffset: z.number().int().positive().meta({
          description: "The settled obligation: the offset of its requesting event.",
        }),
      }),
      examples: [
        {
          description: "The receipt came back clean: APNs/FCM accepted the push.",
          payload: {
            outcome: {
              kind: "accepted-by-push-service",
              ticketId: "0f38e7d2-6a4b-4c8e-9f3a-2b1d5e7c9a01",
            },
            requestOffset: 12,
          },
        },
        {
          description: "Nobody attempted the push before its deadline, so it settled expired.",
          payload: { outcome: { kind: "expired" }, requestOffset: 12 },
        },
      ],
    },
    "events.iterate.com/device/notification-opened": {
      description: "The app observed that the user opened a correlated notification.",
      payloadSchema: z.strictObject({
        openedAt: z
          .string()
          .datetime()
          .meta({ description: "ISO timestamp the app reported for the open." }),
        requestOffset: z.number().int().positive().meta({
          description: "The notification that was opened: the offset of its requesting event.",
        }),
      }),
      examples: [
        {
          description: "The user tapped the approval notification.",
          payload: { openedAt: "2026-07-18T08:12:30.000Z", requestOffset: 12 },
        },
      ],
    },
  },
  consumes: [
    "events.iterate.com/device/created",
    "events.iterate.com/device/notification-requested",
    // The project-level intent (owned by the notification-intent contract),
    // cross-posted onto this stream by the subscription the created/updated
    // lanes configure. It reduces into the same obligation slot as a direct
    // device request.
    "events.iterate.com/notification/requested",
    "events.iterate.com/device/push-token-updated",
    "events.iterate.com/device/revoked",
    "events.iterate.com/device/notification-attempt-started",
    "events.iterate.com/device/notification-ticket-observed",
    "events.iterate.com/device/notification-settled",
    "events.iterate.com/device/notification-opened",
    // The platform revival fact (core-owned). MUST be consumed (this processor
    // registers with recovery): its ordinary delivery is the guaranteed
    // at-head turn where the state-derived pass settles orphaned attempts and
    // expired requests after an eviction. `stream/woken` and
    // `stream/subscriber-connected` are deliberately NOT consumed any more:
    // they were only ever extra re-check-at-head signals, and the runner's
    // final at-head pass makes them redundant.
    "events.iterate.com/stream/processor-revived",
  ],
  emits: [
    // The catalog cross-post: device/created is re-appended onto the project
    // root stream so the project processor can list this device.
    "events.iterate.com/device/created",
    "events.iterate.com/device/notification-attempt-started",
    "events.iterate.com/device/notification-ticket-observed",
    "events.iterate.com/device/notification-settled",
    "events.iterate.com/device/revoked",
    // The notification-intent subscription on the project root stream,
    // (re)armed on created/push-token-updated, removed on revoked.
    "events.iterate.com/stream/subscription-configured",
    "events.iterate.com/stream/subscription-removed",
  ],
});

/**
 * The contract's type under the same identifier, so type-level helpers read
 * without `typeof`: `ProcessorState<DeviceProcessorContract>`,
 * `ConsumedInput<DeviceProcessorContract>`.
 */
export type DeviceProcessorContract = typeof DeviceProcessorContract;

export type DeviceProcessorState = z.output<typeof DeviceProcessorContract.stateSchema>;
export type DeviceNotificationOutcome = z.output<
  (typeof DeviceProcessorContract.events)["events.iterate.com/device/notification-settled"]["payloadSchema"]
>["outcome"];

/**
 * The birth certificate — used twice (the device/created payload and the
 * state's birthCertificate slot). The `config` wrapper is historical wire
 * shape: deployed streams carry it, so it stays.
 */
function deviceBirthCertificateSchema() {
  return z.strictObject({
    config: z
      .strictObject({
        appVersion: z
          .string()
          .trim()
          .min(1)
          .meta({ description: "App build the installation reported at enrollment." }),
        label: z.string().trim().min(1).meta({
          description: 'Human-readable device name shown in the dashboard ("Misha\'s iPhone").',
        }),
        notificationsStatus: z.literal("granted").meta({
          description:
            "OS notification permission at enrollment — enrollment only happens once granted.",
        }),
        ownerId: z
          .string()
          .trim()
          .min(1)
          .meta({ description: "The authenticated user who enrolled this installation." }),
        platform: z
          .enum(["ios", "android"])
          .meta({ description: "The mobile OS — immutable for the installation's lifetime." }),
        pushTokenSecretPath: z
          .string()
          .trim()
          .min(1)
          .meta({
            description:
              "Stream path of the write-only Secret holding the Expo push token; the token " +
              "itself never appears on this stream.",
          }),
        pushTokenSecretUpdatedOffset: z
          .number()
          .int()
          .positive()
          .meta({
            description:
              "The Secret's update offset for the enrolled material — the compare-and-clear " +
              "revision: an invalid response for an older Expo request must not erase Secret " +
              "material rotated while it was in flight.",
          }),
      })
      .meta({ description: "The complete enrollment record." }),
  });
}

/**
 * One notification request — used twice (the device/notification-requested
 * payload and, extended with attempt-progress fields, the state's
 * notifications record).
 */
function deviceNotificationRequestSchema() {
  return z.strictObject({
    body: z
      .string()
      .trim()
      .min(1)
      .max(4_000)
      .meta({ description: "Notification body text (Expo caps total payload size)." }),
    // Reached through the notification-intent contract that OWNS the union:
    // cross-posted `notification/requested` intents reduce into this same
    // state slot, so the two shapes must be the one schema and can never drift.
    destination: NotificationIntentContract.events[
      "events.iterate.com/notification/requested"
    ].payloadSchema.shape.destination.meta({
      description:
        "Where the app navigates when the user opens the notification — the same union " +
        "the project-level notification/requested intent carries.",
    }),
    expiresAt: z
      .number()
      .int()
      .positive()
      .meta({
        description:
          "Epoch-ms deadline for the WHOLE obligation, stamped by the requester: past it the " +
          "processor refuses to dial Expo and settles expired — a late revival must not " +
          "deliver a stale notification.",
      }),
    title: z.string().trim().min(1).max(200).meta({ description: "Notification title line." }),
  });
}
