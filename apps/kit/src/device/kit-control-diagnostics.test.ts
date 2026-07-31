import { describe, expect, test } from "vitest";
import type { KitControlDiagnostics } from "./kit-device-contract.ts";
import {
  kitControlWebsocketErrorTypeName,
  parseKitControlDiagnostics,
} from "./kit-control-diagnostics.ts";

function fixture(): KitControlDiagnostics {
  return {
    schemaVersion: 2,
    producedAtMs: 100_139,
    control: {
      websocketStartAttempts: 2,
      websocketConnections: 2,
      websocketDisconnects: 1,
      websocketErrors: 1,
      wifiDisconnects: 0,
      protocolFailures: 0,
      receiveFailures: 0,
      sendFailures: 0,
      lastWifiDisconnectReason: 0,
      lastErrorGeneration: 1,
      lastErrorType: 2,
      lastTlsError: 0,
      lastTlsStackError: 0,
      lastTransportErrno: 0,
      lastHandshakeStatusCode: 0,
      lastCloseStatusCode: 0,
      protocolFailureGeneration: 0,
      lastApplicationCapnwebGeneration: 0,
      lastApplicationCapnwebStatus: 0,
      lastControlReceiveStatus: 0,
      messagesSent: 40,
      messagesDiscarded: 0,
      inboxDiscarded: 0,
      outboxDiscarded: 0,
      inbox: {
        capacitySlots: 4,
        messagesPublished: 20,
        messagesConsumed: 20,
        producerBackpressure: 0,
        highWaterSlots: 2,
        currentSlots: 0,
      },
      outbox: {
        capacitySlots: 8,
        messagesPublished: 40,
        messagesConsumed: 40,
        producerBackpressure: 0,
        highWaterSlots: 4,
        currentSlots: 0,
      },
    },
  };
}

describe("Kit control diagnostics", () => {
  test("retains the bounded control queues and application-side Cap'n Web failure", () => {
    /*
     * The physical eight-slot run disproved the idea that a larger outbox had
     * fixed the stall: one getDiagnostics resolution still disappeared after
     * 21 seconds while PCM remained clean. A replacement socket must therefore
     * distinguish an application serializer failure from callback ingress and
     * show whether either fixed ring actually reached backpressure. Missing
     * fields may not be defaulted to zero because that would turn lost causal
     * evidence into a healthy-looking reconnect.
     */
    const previous = fixture();
    const value = {
      ...previous,
      schemaVersion: 2,
      control: {
        ...previous.control,
        protocolFailureGeneration: 7,
        lastApplicationCapnwebGeneration: 7,
        lastApplicationCapnwebStatus: -4,
        lastControlReceiveStatus: 0,
        messagesSent: 371,
        messagesDiscarded: 8,
        inboxDiscarded: 0,
        outboxDiscarded: 8,
        inbox: {
          capacitySlots: 4,
          messagesPublished: 812,
          messagesConsumed: 812,
          producerBackpressure: 0,
          highWaterSlots: 3,
          currentSlots: 0,
        },
        outbox: {
          capacitySlots: 8,
          messagesPublished: 1_204,
          messagesConsumed: 1_196,
          producerBackpressure: 1,
          highWaterSlots: 8,
          currentSlots: 0,
        },
      },
    };

    expect(parseKitControlDiagnostics(value)).toEqual(value);
  });

  test("retains the exact SDK tuple and names the classified incident", () => {
    const parsed = parseKitControlDiagnostics(fixture());

    expect(parsed.control).toMatchObject({
      lastErrorGeneration: 1,
      lastErrorType: 2,
      lastTlsError: 0,
      lastTlsStackError: 0,
      lastTransportErrno: 0,
      lastHandshakeStatusCode: 0,
      lastCloseStatusCode: 0,
    });
    expect(kitControlWebsocketErrorTypeName(parsed.control.lastErrorType)).toBe("pongTimeout");
  });

  test("rejects an unknown ESP error category instead of guessing its meaning", () => {
    const value = fixture() as unknown as {
      control: Record<string, unknown>;
    };
    value.control.lastErrorType = 5;

    expect(() => parseKitControlDiagnostics(value)).toThrow(/lastErrorType/u);
  });

  test("rejects missing reconnect evidence instead of manufacturing zeroes", () => {
    const value = fixture() as unknown as {
      control: Record<string, unknown>;
    };
    delete value.control.lastTransportErrno;

    expect(() => parseKitControlDiagnostics(value)).toThrow(/lastTransportErrno/u);
  });
});
