import { WebSocketPair } from "captun";
import { afterEach, describe, expect, test } from "vitest";
import type { KitControlDiagnostics } from "./kit-device-contract.ts";
import { PcmSessionBridge } from "../userspace/config-worker/pcm-proxy.ts";
import { kitDeviceServerVadPolicy } from "../userspace/config-worker/server-vad-policy.ts";
import {
  assessDigitalStackChanRun,
  hasInterruptedCountHardwarePrefix,
  interruptionTranscriptRetainsAcceptancePhrase,
  isCompletedStackChanInterruption,
  isStackChanReadyAndSilent,
  isStackChanSilencePreserved,
  productionSpokenCountPrompt,
  selectAecAcceptanceInterval,
  selectMostCompleteProviderEventSnapshot,
  transcriptRetainsInterruptedCountRequest,
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
    const stackChanVadPolicy = kitDeviceServerVadPolicy("stackchan");
    if (!stackChanVadPolicy) {
      throw new Error("StackChan must retain an explicit server-VAD policy.");
    }

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
      /*
       * Production readiness includes the measured uplink calibration. A
       * default-gain fixture would describe a session the worker no longer
       * installs and could make every otherwise healthy physical run look
       * unready before the harness emits its first controlled utterance.
       */
      uplinkGainMultiplier: stackChanVadPolicy.uplinkGainMultiplier,
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
      serverVadProfile: "low-level-aec",
      sessionId: "stackchan-test-session",
      ...overrides,
    };
  }

  test("excludes the harness hang-up reset from the in-call AEC ledger", () => {
    /*
     * The AEC callback remains live while the proof tears its conversation
     * down. A successful HAVPE barge-in therefore produced one authorized
     * in-call reset, then conversation.hangUp() produced a second reset after
     * the terminal evidence snapshot. Letting the later callback into the
     * acceptance slice made a correct exact ledger fail as an unexplained
     * surplus. Capture the end index before hang-up and prove the selector
     * excludes that teardown sample; widening the allowed reset count would
     * instead hide real spontaneous resets during the call.
     */
    const samples = [
      { receivedAtMs: 1, value: "preflight" },
      { receivedAtMs: 2, value: "media-baseline" },
      { receivedAtMs: 3, value: "authorized-barge-in-reset" },
      { receivedAtMs: 4, value: "terminal" },
      { receivedAtMs: 5, value: "hang-up-reset" },
    ];

    expect(selectAecAcceptanceInterval(samples, 1, 4)).toEqual([
      "media-baseline",
      "authorized-barge-in-reset",
      "terminal",
    ]);
  });

  test("states the spoken-count direction independently of its first word", () => {
    /*
     * A real count-to-100 run played “Count from 1 through 100”, but xAI's
     * input transcript lost the leading consonant and heard “Down from one
     * through one hundred”. Grok then followed that plausible command exactly
     * and counted 100..1. The physical transport was healthy; the oracle had
     * made one acoustically fragile word carry the entire direction contract.
     * Repeat the direction as “upwards” and name both boundary roles so a
     * clipped first phoneme cannot invert a 76-second acceptance stimulus.
     */
    expect(productionSpokenCountPrompt({ start: 1, end: 100 })).toBe(
      "Count upwards from 1 through 100. Start with 1, end with 100, include both endpoints, " +
        "and say every number exactly once, with no preamble and no omissions",
    );
  });

  test("does not mistake worker sends for an audibly played count prefix", () => {
    /*
     * Grok generated 153.752 seconds of 300..400 PCM in 20.85 seconds. A sent
     * frame therefore proves only that userspace admitted future audio; the
     * hardware-release ledger is the boundary that says the speaker consumed
     * it. This preserves the 25-number interruption requirement without the
     * old, physically impossible 12-second proxy or a queue-depth guess.
     */
    const baseline = workerMetrics({ downlinkItemsAcknowledged: 100 });

    expect(
      hasInterruptedCountHardwarePrefix(baseline, {
        ...baseline,
        downlinkFrames: baseline.downlinkFrames + 2_250,
        downlinkItemsAcknowledged: baseline.downlinkItemsAcknowledged + 600,
      }),
    ).toBe(false);
    expect(
      hasInterruptedCountHardwarePrefix(baseline, {
        ...baseline,
        downlinkFrames: baseline.downlinkFrames + 2_266,
        downlinkItemsAcknowledged: baseline.downlinkItemsAcknowledged + 2_250,
      }),
    ).toBe(true);
  });

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
      expectedIdlePlaybackInterruptionsSkipped: 2,
      expectedPhysicalPlaybackInterruptions: 1,
      expectedProviderTurns: 3,
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
    expect(isStackChanReadyAndSilent({ ...ready, serverVadProfile: "xmos-aec" }, "stackchan")).toBe(
      false,
    );
    expect(isStackChanReadyAndSilent({ ...ready, providerResponseActive: true }, "stackchan")).toBe(
      false,
    );
    expect(isStackChanReadyAndSilent({ ...ready, uplinkGainMultiplier: 8 }, "stackchan")).toBe(
      false,
    );
  });

  test("requires silence to remain intact before the scripted near-end prompt", () => {
    /*
     * A single ready-and-silent sample does not make the room quiet. In the
     * first exact-reference Grok run, incidental speech reached server VAD in
     * the small gap between that sample and the Mac's controlled utterance.
     * The resulting extra turn was real provider behaviour, but it could not
     * distinguish ambient near speech from speaker echo. Keeping this as an
     * interval invariant makes every later VAD edge causally attributable to
     * the acoustic stimulus that the proof owns.
     */
    const baseline = workerMetrics({
      audioMode: "full-duplex-aec",
      conversationActive: true,
      providerAvailable: true,
      providerSessionReadyAtMs: 2_000,
    });

    expect(isStackChanSilencePreserved(baseline, { ...baseline })).toBe(true);
    expect(
      isStackChanSilencePreserved(baseline, {
        ...baseline,
        providerSpeechStarts: baseline.providerSpeechStarts + 1,
      }),
    ).toBe(false);
    expect(
      isStackChanSilencePreserved(baseline, {
        ...baseline,
        providerResponseCreateMessagesSent: baseline.providerResponseCreateMessagesSent + 1,
      }),
    ).toBe(false);
    expect(
      isStackChanSilencePreserved(baseline, {
        ...baseline,
        downlinkFrames: baseline.downlinkFrames + 1,
      }),
    ).toBe(false);
    expect(
      isStackChanSilencePreserved(baseline, {
        ...baseline,
        sessionId: "replacement-generation",
      }),
    ).toBe(false);
  });

  test("rejects a bounded server-VAD recovery inside the acceptance interval", () => {
    /*
     * Retiring a stuck provider is the correct availability/privacy recovery,
     * but it is not evidence of a clean conversation. The physical proof must
     * retain that distinction instead of declaring success merely because the
     * replacement generation eventually answers.
     */
    const baseline = workerMetrics({
      audioMode: "full-duplex-aec",
      conversationActive: true,
      providerSessionReadyAtMs: 2_000,
    });
    const terminal = workerMetrics({
      ...baseline,
      downlinkFrames: 1,
      providerSpeechTimeouts: 1,
      uplinkFrames: 1,
    });
    const diagnostics = {
      control: { websocketConnections: 1 },
      network: { pcmWebsocketConnections: 1, pcmWebsocketDisconnects: 0 },
    } as KitControlDiagnostics;

    const assessment = assessDigitalStackChanRun({
      baselineDiagnostics: diagnostics,
      expectedIdlePlaybackInterruptionsSkipped: 2,
      expectedPhysicalPlaybackInterruptions: 1,
      expectedProviderTurns: 3,
      mediaBaselineWorker: baseline,
      sessionOpenedWorker: baseline,
      terminalDiagnostics: diagnostics,
      terminalWorker: terminal,
    });

    expect(assessment.passed).toBe(false);
    expect(assessment.reasons).toContain("Worker providerSpeechTimeouts changed by 1.");
  });

  test("rejects provider-bound microphone clipping even when raw transport progresses", () => {
    /*
     * HAVPE needs fixed gain after its echo-suppressed XMOS tap, but a loud
     * room or later DSP revision can exceed that calibration. Frames and VAD
     * may continue normally while saturation destroys intelligibility and AEC
     * evidence. The physical verdict must therefore treat even one gained
     * clipped sample as a failed run, not merely an informational level metric.
     */
    const baseline = workerMetrics({
      audioMode: "full-duplex-aec",
      conversationActive: true,
      providerSessionReadyAtMs: 2_000,
    });
    const terminal = workerMetrics({
      ...baseline,
      downlinkFrames: 1,
      uplinkFrames: 1,
      uplinkPcmClippedSamples: 2,
    });
    const diagnostics = {
      control: { websocketConnections: 1 },
      network: { pcmWebsocketConnections: 1, pcmWebsocketDisconnects: 0 },
    } as KitControlDiagnostics;

    const assessment = assessDigitalStackChanRun({
      baselineDiagnostics: diagnostics,
      expectedIdlePlaybackInterruptionsSkipped: 2,
      expectedPhysicalPlaybackInterruptions: 1,
      expectedProviderTurns: 3,
      mediaBaselineWorker: baseline,
      sessionOpenedWorker: baseline,
      terminalDiagnostics: diagnostics,
      terminalWorker: terminal,
    });

    expect(assessment.reasons).toContain("Worker uplinkPcmClippedSamples changed by 2.");
  });

  test("rejects an extra VAD turn even when every expected response completed", () => {
    /*
     * The AGC-tap HAVPE run produced six VAD starts for three planned
     * utterances: its own speaker audio opened extra turns and interrupted
     * legitimate replies. Earlier waits used only greater-than comparisons,
     * so all expected turns completing concealed the defining failure. Exact
     * deltas make an echo-triggered fourth turn a digital acceptance failure.
     */
    const baseline = workerMetrics({
      audioMode: "full-duplex-aec",
      conversationActive: true,
      providerSessionReadyAtMs: 2_000,
    });
    const terminal = workerMetrics({
      ...baseline,
      downlinkFrames: 1,
      playbackInterruptionsCompleted: 4,
      playbackInterruptionsRequested: 4,
      providerResponsesCompleted: 4,
      providerSpeechStarts: 4,
      providerSpeechStops: 4,
      uplinkFrames: 1,
    });
    const diagnostics = {
      control: { websocketConnections: 1 },
      network: { pcmWebsocketConnections: 1, pcmWebsocketDisconnects: 0 },
    } as KitControlDiagnostics;

    const assessment = assessDigitalStackChanRun({
      baselineDiagnostics: diagnostics,
      expectedIdlePlaybackInterruptionsSkipped: 2,
      expectedPhysicalPlaybackInterruptions: 1,
      expectedProviderTurns: 3,
      mediaBaselineWorker: baseline,
      sessionOpenedWorker: baseline,
      terminalDiagnostics: diagnostics,
      terminalWorker: terminal,
    });

    expect(assessment.passed).toBe(false);
    expect(assessment.reasons).toContain(
      "Worker providerSpeechStarts changed by 4; expected exactly 3 planned turns.",
    );
  });

  test("separates idle VAD edges from the one physical barge-in purge", () => {
    /*
     * A normal caller turn begins while the speaker is idle, as does the
     * long-response setup utterance. Only the later barge-in has stale audio
     * at the DAC. Treating all three VAD edges as reset commands caused the
     * proof to time out after a digitally exact HAVPE reply and encouraged a
     * real I2S/AEC reference reset on every turn. This fixture preserves exact
     * edge accounting while proving the two classes have different counts.
     */
    const baseline = workerMetrics();
    const terminal = workerMetrics({
      ...baseline,
      downlinkFrames: 1,
      playbackInterruptionsCompleted: 1,
      playbackInterruptionsRequested: 1,
      playbackInterruptionsSkippedIdle: 2,
      providerSpeechStarts: 3,
      providerSpeechStops: 3,
      uplinkFrames: 1,
    });
    const diagnostics = {
      control: { websocketConnections: 1 },
      network: { pcmWebsocketConnections: 1, pcmWebsocketDisconnects: 0 },
    } as KitControlDiagnostics;

    const assessment = assessDigitalStackChanRun({
      baselineDiagnostics: diagnostics,
      expectedIdlePlaybackInterruptionsSkipped: 2,
      expectedPhysicalPlaybackInterruptions: 1,
      expectedProviderTurns: 3,
      mediaBaselineWorker: baseline,
      sessionOpenedWorker: baseline,
      terminalDiagnostics: diagnostics,
      terminalWorker: terminal,
    });

    expect(
      assessment.reasons.filter(
        (reason) =>
          reason.includes("playbackInterruptionsRequested") ||
          reason.includes("playbackInterruptionsCompleted") ||
          reason.includes("playbackInterruptionsSkippedIdle") ||
          reason.includes("providerSpeechStarts") ||
          reason.includes("providerSpeechStops"),
      ),
    ).toEqual([]);
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
    expect(
      interruptionTranscriptRetainsAcceptancePhrase("Stack Shannon interruption worked."),
    ).toBe(false);
    expect(interruptionTranscriptRetainsAcceptancePhrase("The interruption might work.")).toBe(
      false,
    );
  });

  test("accepts word or digit renderings of the deliberate 300-to-400 request", () => {
    /*
     * Grok's input recognizer may spell endpoints or render digits. Requiring
     * one typography would reject the same physical utterance, while checking
     * only the word “count” could accept an unrelated contaminated turn.
     */
    expect(
      transcriptRetainsInterruptedCountRequest("Count from three hundred through four hundred."),
    ).toBe(true);
    expect(transcriptRetainsInterruptedCountRequest("Please count 300 to 400 in order.")).toBe(
      true,
    );
    expect(transcriptRetainsInterruptedCountRequest("Count from 300 to 350.")).toBe(false);
    expect(transcriptRetainsInterruptedCountRequest("Tell me about four hundred robots.")).toBe(
      false,
    );
  });
});
