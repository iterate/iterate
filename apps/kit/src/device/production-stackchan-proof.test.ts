import { WebSocketPair } from "captun";
import { afterEach, describe, expect, test } from "vitest";
import type { KitControlDiagnostics } from "./kit-device-contract.ts";
import { PcmSessionBridge } from "../userspace/config-worker/pcm-proxy.ts";
import {
  assessDigitalStackChanRun,
  type ProductionPcmMetrics,
} from "../../scripts/prove-production-stackchan-grok.ts";

type AcceptingWebSocket = WebSocket & { accept(): void };

describe("StackChan production evidence assembly", () => {
  const sockets: WebSocket[] = [];

  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.close();
  });

  function workerMetrics(overrides: Partial<ProductionPcmMetrics> = {}): ProductionPcmMetrics {
    const pair = new WebSocketPair();
    const client = pair[0] as AcceptingWebSocket;
    const server = pair[1] as AcceptingWebSocket;
    client.accept();
    server.accept();
    sockets.push(client, server);
    const bridge = new PcmSessionBridge({
      device: server,
      maximumSocketBufferedBytes: 640 * 8,
      sessionId: "stackchan-test-session",
      turnDetection: "server-vad",
    });

    return {
      ...bridge.metrics(),
      audioMode: "server-vad",
      conversationStartedAtMs: 1_000,
      deviceEvents: {
        acceptedEvents: 0,
        lastEvent: null,
        physicalConversationEnds: 0,
        physicalConversationStarts: 0,
        physicalStarts: 0,
        physicalStops: 0,
        remoteConversationEnds: 0,
        remoteConversationStarts: 0,
        remoteStarts: 0,
        remoteStops: 0,
      },
      deviceEventSubscriptionAttempts: 1,
      deviceEventSubscriptionFailures: 0,
      deviceId: "stackchan",
      deviceMetrics: {
        invalidSamples: 0,
        lastInvalidReason: null,
        latestSample: null,
        samplesReceived: 0,
      },
      providerConnectFailures: 0,
      providerEvents: {
        appendFailures: 0,
        appendedEvents: 0,
        droppedEvents: 0,
        lastAppendError: null,
        lastAppendedSequence: 0,
        observedEvents: 0,
        pendingEvents: 0,
        pendingRawBytes: 0,
        pendingRawHighWaterBytes: 0,
      },
      providerSessionReadyAtMs: 2_000,
      sessionId: "stackchan-test-session",
      ...overrides,
    };
  }

  test("retains a missing metrics subscription as failed evidence instead of throwing", () => {
    /*
     * The first unattended production run used both finite device callback
     * slots for direct harness observers. The real userspace worker therefore
     * retained no general metrics sample, and the evidence assembler threw
     * while handling that secondary diagnostics failure. That erased the more
     * important primary observation that Grok had received PCM but server VAD
     * had not fired. Physical runs are expensive and non-repeatable: absent
     * telemetry must fail the verdict while still returning a durable report.
     */
    const diagnostics = {
      control: { websocketConnections: 1 },
      network: {
        pcmWebsocketConnections: 1,
        pcmWebsocketDisconnects: 0,
      },
    } as KitControlDiagnostics;
    const baseline = workerMetrics();
    const terminal = workerMetrics({ downlinkFrames: 1, uplinkFrames: 1 });

    const assessment = assessDigitalStackChanRun({
      baselineDiagnostics: diagnostics,
      mediaBaselineWorker: baseline,
      sessionOpenedWorker: baseline,
      terminalDiagnostics: diagnostics,
      terminalWorker: terminal,
    });

    expect(assessment.passed).toBe(false);
    expect(assessment.reasons).toContain(
      "The userspace worker retained no StackChan metrics sample at the media baseline.",
    );
    expect(assessment.reasons).toContain(
      "The userspace worker retained no StackChan metrics sample at the terminal.",
    );
  });
});
