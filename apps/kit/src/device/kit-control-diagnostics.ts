import { z } from "zod";
import type {
  KitCapnwebStatus,
  KitControlDiagnostics,
  KitControlWebsocketErrorType,
} from "./kit-device-contract.ts";

const uint32 = z.number().int().min(0).max(0xffff_ffff);
const int32 = z.number().int().min(-0x8000_0000).max(0x7fff_ffff);
const capnwebStatus = z.union([
  z.literal(0),
  z.literal(-1),
  z.literal(-2),
  z.literal(-3),
  z.literal(-4),
  z.literal(-5),
  z.literal(-6),
  z.literal(-7),
  z.literal(-8),
  z.literal(-9),
]) satisfies z.ZodType<KitCapnwebStatus>;
const ringDiagnosticsSchema = z.strictObject({
  capacitySlots: uint32,
  messagesPublished: uint32,
  messagesConsumed: uint32,
  producerBackpressure: uint32,
  highWaterSlots: uint32,
  currentSlots: uint32,
});

/*
 * This value crosses an independently implemented C/Cap'n Web boundary after
 * the ordinary metrics subscription has died. Strict validation is essential:
 * treating a missing SDK field as zero would turn absent causal evidence into
 * an apparently clean reconnect and violate the physical rig's fail-closed
 * contract.
 */
const controlDiagnosticsSchema = z.strictObject({
  schemaVersion: z.literal(2),
  producedAtMs: z.number().int().nonnegative().safe(),
  control: z.strictObject({
    websocketStartAttempts: uint32,
    websocketConnections: uint32,
    websocketDisconnects: uint32,
    websocketErrors: uint32,
    wifiDisconnects: uint32,
    protocolFailures: uint32,
    receiveFailures: uint32,
    sendFailures: uint32,
    lastWifiDisconnectReason: int32,
    lastErrorGeneration: uint32,
    /*
     * ESP-IDF's enum is stable and finite. Rejecting a new value forces us to
     * inspect the upgraded SDK rather than silently mislabel the root cause.
     */
    lastErrorType: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
    lastTlsError: int32,
    lastTlsStackError: int32,
    lastTransportErrno: int32,
    lastHandshakeStatusCode: int32,
    lastCloseStatusCode: int32,
    protocolFailureGeneration: uint32,
    lastApplicationCapnwebGeneration: uint32,
    lastApplicationCapnwebStatus: capnwebStatus,
    lastControlReceiveStatus: capnwebStatus,
    messagesSent: uint32,
    messagesDiscarded: uint32,
    inboxDiscarded: uint32,
    outboxDiscarded: uint32,
    inbox: ringDiagnosticsSchema,
    outbox: ringDiagnosticsSchema,
  }),
});

const websocketErrorTypeNames = {
  0: "none",
  1: "tcpTransport",
  2: "pongTimeout",
  3: "handshake",
  4: "serverClose",
} as const satisfies Record<KitControlWebsocketErrorType, string>;

export function parseKitControlDiagnostics(value: unknown): KitControlDiagnostics {
  return controlDiagnosticsSchema.parse(value) as KitControlDiagnostics;
}

export function kitControlWebsocketErrorTypeName(
  errorType: KitControlWebsocketErrorType,
): (typeof websocketErrorTypeNames)[KitControlWebsocketErrorType] {
  return websocketErrorTypeNames[errorType];
}
