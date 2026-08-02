import { WebSocketPair } from "captun";
import { afterEach, describe, expect, test } from "vitest";
import type { KitControlDiagnostics } from "./kit-device-contract.ts";
import { PcmSessionBridge } from "../userspace/config-worker/pcm-proxy.ts";
import {
  assessDigitalStackChanRun,
  interruptionTranscriptRetainsAcceptancePhrase,
  isCompletedStackChanInterruption,
  isStackChanReadyAndSilent,
  selectMostCompleteProviderEventSnapshot,
  type ProductionPcmMetrics,
  unexplainedStackChanDownlinkDroppedBytes,
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

  test("starts the first physical turn from a provider-ready silent generation", () => {
    /*
     * The product contract deliberately stopped Grok speaking when a call
     * opens. StackChan's old proof still waited for an unsolicited greeting,
     * so a completely healthy generation streamed microphone PCM for thirty
     * seconds and was then misclassified as a timeout. This boundary is more
     * than a convenience predicate: it proves that the provider handshake is
     * complete while no assistant response or downlink sample has escaped
     * before the test harness speaks the first near-end prompt.
     */
    const ready = workerMetrics({
      audioMode: "full-duplex-aec",
      conversationActive: true,
      deviceId: "stackchan",
      initialGreetingRequests: 0,
      providerAvailable: true,
      providerSessionReadyAtMs: 2_000,
    });

    expect(isStackChanReadyAndSilent(ready, "stackchan")).toBe(true);
    expect(
      isStackChanReadyAndSilent(
        { ...ready, initialGreetingRequests: 1, providerResponsesCompleted: 1 },
        "stackchan",
      ),
    ).toBe(false);
    expect(isStackChanReadyAndSilent({ ...ready, downlinkFrames: 1 }, "stackchan")).toBe(false);
    expect(isStackChanReadyAndSilent({ ...ready, providerResponseActive: true }, "stackchan")).toBe(
      false,
    );
  });

  test("separates deliberate interruption discard from unexplained downlink loss", () => {
    /*
     * Barge-in succeeds by destroying obsolete assistant audio, so a global
     * zero-drop assertion rejects the feature it is supposed to prove. The
     * interruption counter is a strict subset, not an exemption: conservation
     * still requires every other dropped byte to remain zero, and an
     * impossible subset larger than the total must remain visibly invalid.
     */
    const baseline = workerMetrics();

    expect(
      unexplainedStackChanDownlinkDroppedBytes(baseline, {
        ...baseline,
        downlinkDroppedBytes: 300,
        downlinkInterruptedBytes: 300,
      }),
    ).toBe(0);
    expect(
      unexplainedStackChanDownlinkDroppedBytes(baseline, {
        ...baseline,
        downlinkDroppedBytes: 301,
        downlinkInterruptedBytes: 300,
      }),
    ).toBe(1);
    expect(
      unexplainedStackChanDownlinkDroppedBytes(baseline, {
        ...baseline,
        downlinkDroppedBytes: 299,
        downlinkInterruptedBytes: 300,
      }),
    ).toBe(-1);
  });

  test("refreshes a non-empty provider-event snapshot after a later phase fails", () => {
    /*
     * The first successful turn used to populate the artifact array once.
     * When barge-in failed later, failure assembly skipped recovery merely
     * because that stale array was non-empty, hiding every event that could
     * explain the failure. Prefer the snapshot with the furthest monotonic
     * provider sequence while retaining the old one if an eventually
     * consistent stream read happens to return an older prefix.
     */
    const event = (sequence: number) => ({
      createdAt: "2026-08-02T00:00:00.000Z",
      offset: sequence,
      providerType: "ping",
      raw: '{"type":"ping"}',
      receivedAtMs: sequence,
      sequence,
      sessionId: "stackchan-test-session",
    });
    const firstTurn = [event(1)];
    const terminal = [event(1), event(2)];

    expect(selectMostCompleteProviderEventSnapshot(firstTurn, terminal)).toBe(terminal);
    expect(selectMostCompleteProviderEventSnapshot(terminal, firstTurn)).toBe(terminal);
  });

  test("accepts interruption whether the old fast-generated response cancels or finishes", () => {
    /*
     * Grok can finish generating a minute-long answer faster than the speaker
     * plays it. If near-end speech arrives after generation completed but
     * while queued audio is still audible, there is no live provider response
     * left to cancel; the required operation is still to purge obsolete
     * playback and complete the replacement response. The ledger therefore
     * requires two terminal old/new outcomes, one new completed answer, and a
     * physical purge—without pretending cancellation is the only valid race.
     */
    const baseline = workerMetrics({ providerResponsesCompleted: 1 });
    const active = workerMetrics({
      downlinkFrames: 10,
      playbackInterruptionsCompleted: 2,
      playbackInterruptionsRequested: 2,
      providerResponseActive: true,
      providerResponsesCompleted: 1,
      providerSpeechStarts: 2,
      providerSpeechStops: 2,
    });
    const terminal = (overrides: Partial<ProductionPcmMetrics>) =>
      workerMetrics({
        conversationActive: true,
        downlinkDroppedBytes: 640,
        downlinkFrames: 20,
        downlinkInterruptedBytes: 640,
        playbackInterruptionsCompleted: 3,
        playbackInterruptionsRequested: 3,
        providerResponseActive: false,
        providerResponsesCompleted: 2,
        providerSpeechStarts: 3,
        providerSpeechStops: 3,
        ...overrides,
      });

    expect(
      isCompletedStackChanInterruption(
        baseline,
        active,
        terminal({ providerResponsesCancelled: 1 }),
      ),
    ).toBe(true);
    expect(
      isCompletedStackChanInterruption(
        baseline,
        active,
        terminal({ providerResponsesCompleted: 3 }),
      ),
    ).toBe(true);
    expect(isCompletedStackChanInterruption(baseline, active, terminal({}))).toBe(false);
  });

  test("uses an interruption oracle that does not depend on brand-name transcription", () => {
    /*
     * A physical oracle must distinguish the replacement response without
     * depending on how a speech model spells "StackChan". Real runs produced
     * "Stack Chan", "Stack channel", and "Stack Shannon", turning a product
     * name into provider roulette. Use ordinary, unambiguous words and keep
     * their semantic match strict.
     */
    expect(interruptionTranscriptRetainsAcceptancePhrase("Interruption test complete.")).toBe(true);
    expect(interruptionTranscriptRetainsAcceptancePhrase("Stack Shannon interruption worked.")).toBe(
      false,
    );
    expect(interruptionTranscriptRetainsAcceptancePhrase("The interruption might work.")).toBe(
      false,
    );
  });
});
