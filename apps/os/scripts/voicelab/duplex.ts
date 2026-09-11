// Full duplex through the platform, proven from the wire — no microphone, no
// speaker, no buttons anywhere, and a real GPT-Live on the far end.
//
//   doppler run --config dev_jonas -- pnpm cli voicelab duplex --project live1 --setup
//   doppler run --config prd -- pnpm cli voicelab duplex --project templestein \
//     --stream-path /agents/voice/duplex-1 --setup --backend-model gpt-6-astra
//
// The driver (wire-call.ts) is the dumbest possible client: it appends
// microphone frames at realtime pace for the whole run (silence when it has
// nothing to say) and reads the speaker frames and the mirrored provider
// events back. Everything below is read off the wire rather than assumed:
//
//   1. SESSION — the facet dialled GPT-Live and the session started: the
//      durable `session-configured` names the provider and the delegation
//      mode, `conversation-accepted` carries the handshake time.
//   2. FULL DUPLEX — the microphone never stops: frames flow up for the whole
//      run, including while answer frames flow down.
//   3. ANSWERS — a spoken request draws speech in the speaker frames, and each
//      answer ends with the facet's `lastFrameOfAnswer` marker (GPT-Live has
//      no end-of-answer event; the marker is inferred from silence).
//   4. IDLE DOWNLINK — between answers NO speaker frames flow: the
//      provider's continuous silence is dropped at the facet, not shipped.
//   5. THE SPOKEN BARGE — talking over the answer makes the voice stop within
//      a bounded time, with no clear needed, and the interruption is answered.
//   6. TRANSCRIPT — both sides land as durable utterance/answer events.
//   7. DELEGATION — a request that needs the backend draws
//      `session.delegation.created` on the mirror, the backend calls
//      exec_typescript (a nested `response.event` function call answered by
//      the facet), its final text lands durably as `backend-reply`, and the
//      voice speaks it.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import { type VoicelabConnectOptions } from "./connect.ts";
import { sleep, synthesizeFrames } from "./probe-audio.ts";
import { gapStats } from "./live-probe.ts";
import { talk } from "./talk.ts";
import { openWireCall } from "./wire-call.ts";

/** Options for `pnpm cli voicelab duplex`. */
export interface DuplexOptions extends VoicelabConnectOptions {
  /** The stream whose agent is under test. A fresh timestamped path when omitted. */
  streamPath?: string;
  /** Install the agent on the stream first (talk --setup-only --open-mic). */
  setup?: boolean;
  /** With --setup: the backend model (gpt-6-astra by default). */
  backendModel?: string;
  /** With --setup: reasoning effort for the backend. */
  backendEffort?: string;
  /** Barge once this much of the counting answer has been DELIVERED to the device. */
  bargeAfterMs?: number;
  /** Skip the delegation leg (a backend that is not wired up locally). */
  skipDelegation?: boolean;
  /** How long to wait for the backend's spoken reply. */
  delegationTimeoutMs?: number;
  /** Microphone frames per append (default 25 = one append per 500 ms). */
  micBatchFrames?: number;
  /** Frames joined into one mic event (default 1). */
  micEventFrames?: number;
  /** Unconsumed ephemeral events added to every mic append (default 0). */
  noiseEventsPerAppend?: number;
  /** Consumed-but-not-forwarded keepalive events added to every mic append (default 0). */
  keepaliveEventsPerAppend?: number;
}

export async function duplex(options: DuplexOptions): Promise<void> {
  const streamPath =
    options.streamPath ??
    `/agents/voice/duplex-${new Date().toISOString().replace(/\D/g, "").slice(2, 14)}-${Math.random()
      .toString(36)
      .slice(2, 6)}`;
  const bargeAfterMs = options.bargeAfterMs ?? 4_000;
  const delegationTimeoutMs = options.delegationTimeoutMs ?? 150_000;

  if (options.setup === true) {
    await talk({
      project: options.project,
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
      streamPath,
      setupOnly: true,
      auto: true,
      openMic: true,
      ...(options.backendModel === undefined
        ? {}
        : {
            backendModel: options.backendModel,
            backendEffort: options.backendEffort ?? "low",
            backendServiceTier: "priority",
          }),
    });
  }

  const dir = mkdtempSync(path.join(tmpdir(), "duplex-"));
  const request = synthesizeFrames(
    dir,
    "request",
    "Please count slowly from one to fifty, one number at a time, and do not stop early.",
  );
  const interjection = synthesizeFrames(
    dir,
    "interjection",
    "Stop counting please. Tell me the last number you said out loud.",
  );
  const delegation = synthesizeFrames(
    dir,
    "delegation",
    "Can you check what files are in my project's config repo, and tell me how many there are?",
  );
  rmSync(dir, { recursive: true, force: true });

  const call = await openWireCall({ ...options, streamPath });
  console.log(
    `  mic: ${String(options.micBatchFrames ?? 25)} frames per append, ${String(options.micEventFrames ?? 1)} frames per event`,
  );
  const { watch } = call;

  const verdict: Record<string, boolean | null> = {};
  const fail = (message: string) => {
    console.log(`  FAIL: ${message}`);
    process.exitCode = 1;
  };

  /* 1. SESSION: the first frames mint the call and dial. */
  console.log(`  open mic running on ${streamPath}; waiting for the session…`);
  await sleep(1_500);
  const started = await call.waitFor(
    () => call.micFramesSent() > 0 && watch.providerEventCounts["session.started"] !== undefined,
    30_000,
  );
  if (!started) fail("the call never became live (no session.started on the mirror)");

  /* 3/4/5. The counting answer, a quiet window is impossible mid-count, so
   * measure the idle downlink before speaking: the session is up and the
   * voice has nothing to say. */
  const spkFramesBeforeQuiet = watch.spkFrames;
  await sleep(3_000);
  const spkFramesInQuietWindow = watch.spkFrames - spkFramesBeforeQuiet;
  verdict.idleDownlink = spkFramesInQuietWindow === 0;
  if (!verdict.idleDownlink)
    fail(`${String(spkFramesInQuietWindow)} speaker frames arrived while the voice was idle`);

  console.log(`  speaking the count request (${String(request.length)} frames)…`);
  void call.speak(request);
  const counting = await call.waitFor(() => watch.answerDeliveredMs >= bargeAfterMs, 60_000);
  if (!counting)
    fail(`only ${String(Math.round(watch.answerDeliveredMs))}ms of answer arrived in 60s`);
  const answersBeforeBarge = watch.answersEnded;
  const clearsBeforeBarge = watch.clearsSeen;

  console.log(
    `  answer playing (${String(Math.round(watch.answerDeliveredMs))}ms delivered); talking over it…`,
  );
  const bargeSpokenAtMs = call.clock();
  void call.speak(interjection);
  /* The voice should go quiet: no audio frame for 700 ms after the barge began. */
  const stopped = await call.waitFor(
    () => call.quietFor(700) && call.clock() > bargeSpokenAtMs + 700,
    20_000,
  );
  const stoppedAfterBargeMs =
    stopped && watch.lastAudioFrameAtMs !== null
      ? Math.max(0, watch.lastAudioFrameAtMs - bargeSpokenAtMs)
      : null;
  const replied = await call.waitFor(() => watch.answersEnded >= answersBeforeBarge + 2, 30_000);
  verdict.answers = watch.answersEnded >= 2;
  verdict.barge = stoppedAfterBargeMs !== null && stoppedAfterBargeMs < 2_500 && replied;
  if (!verdict.barge) {
    fail(
      `barge: voice stopped ${String(stoppedAfterBargeMs)}ms after the interruption; answers ended ${String(watch.answersEnded)} (wanted ≥ ${String(answersBeforeBarge + 2)})`,
    );
  }
  /* No clear is NEEDED on GPT-Live — the model yields itself — so a clear
   * here would only come from a button, which this driver has none of. */
  verdict.noClearNeeded = watch.clearsSeen === clearsBeforeBarge;

  /* 7. DELEGATION. */
  let firstSpeechAfterDelegationMs: number | null = null;
  if (options.skipDelegation !== true) {
    await call.waitFor(() => call.quietFor(1_500), 15_000);
    console.log(`  asking something that needs the backend…`);
    const answersBefore = watch.answersEnded;
    const delegationsBefore = watch.delegations.length;
    void call.speak(delegation);
    const delegated = await call.waitFor(
      () => watch.delegations.length > delegationsBefore,
      30_000,
    );
    const raised = watch.delegations[delegationsBefore];
    if (!delegated || raised === undefined) {
      fail("no session.delegation.created within 30s of the request");
    } else {
      console.log(`  delegation created (target ${raised.target}); waiting for the backend…`);
      /* First speech after the delegation, to the 100 ms poll. */
      await call.waitFor(
        () => watch.lastAudioFrameAtMs !== null && watch.lastAudioFrameAtMs > raised.createdAtMs,
        30_000,
      );
      if (watch.lastAudioFrameAtMs !== null && watch.lastAudioFrameAtMs > raised.createdAtMs) {
        firstSpeechAfterDelegationMs = watch.lastAudioFrameAtMs - raised.createdAtMs;
      }
    }
    const answeredByBackend = await call.waitFor(
      () =>
        raised !== undefined &&
        raised.functionCalls > 0 &&
        raised.finalTextDoneAtMs !== null &&
        watch.answersEnded > answersBefore + 1,
      delegationTimeoutMs,
    );
    verdict.delegation = delegated && answeredByBackend;
    if (!answeredByBackend) {
      fail(
        `the backend's reply never reached the voice (function calls ${String(watch.backendFunctionCalls)}, answers ended ${String(watch.answersEnded)})`,
      );
    }
    await call.waitFor(() => call.quietFor(1_500), 30_000);
  }

  await call.stop();
  /* Let the durable transcript appends land. */
  await sleep(2_500);

  /* 1 + 6. SESSION and TRANSCRIPT: durable, readable after the fact. */
  const durable = await call.durableEvents();
  const accepted = durable.some((e) => e.type.endsWith("/conversation-accepted"));
  verdict.session = started && accepted;
  if (!accepted) fail("the call never became live (no conversation-accepted on the stream)");
  const utterances = durable.filter((e) => e.type.endsWith("/utterance-transcript"));
  const answers = durable.filter((e) => e.type.endsWith("/answer-transcript"));
  const notes = durable.filter((e) => e.type.endsWith("/backend-reply"));
  verdict.transcript = utterances.length >= 2 && answers.length >= 2;
  if (!verdict.transcript) {
    fail(
      `transcript: ${String(utterances.length)} utterances, ${String(answers.length)} answers on the stream`,
    );
  }
  verdict.duplex = call.micFramesSent() > 0;

  const raised = watch.delegations[0];
  console.log(`\n  FULL DUPLEX THROUGH THE PLATFORM (GPT-Live)`);
  console.log(
    `    mic frames sent           ${String(call.micFramesSent())} (continuous, no button events)`,
  );
  console.log(
    `    idle speaker frames       ${String(spkFramesInQuietWindow)} in a 3 s quiet window`,
  );
  console.log(`    answers ended (markers)   ${String(watch.answersEnded)}`);
  console.log(`    answer audio delivered    ${String(Math.round(watch.answerDeliveredMs))}ms`);
  console.log(`    voice stopped after barge ${String(stoppedAfterBargeMs)}ms`);
  console.log(`    clears                    ${String(watch.clearsSeen)}`);
  console.log(
    `    delegation                ${raised === undefined ? "none" : `${raised.target}, first speech ${String(firstSpeechAfterDelegationMs ?? "?")}ms after it`}`,
  );
  console.log(`    backend function calls    ${String(watch.backendFunctionCalls)}`);
  console.log(
    `    durable transcript        ${String(utterances.length)} utterances, ${String(answers.length)} answers, ${String(notes.length)} backend notes`,
  );
  /*
   * THE CADENCE THE DEVICE SEES. Consecutive audio frames should arrive
   * 100 ms apart (GPT-Live's own cadence); a device playing straight from
   * arrival has, at each frame, a cushion of (audio delivered so far) minus
   * (time elapsed since the first frame of that run) — negative means it
   * has already run dry. Runs restart at every answer-end marker.
   */
  const gaps = gapStats(watch.spkArrivals.map((arrival) => arrival.atMs));
  let cushionMinMs = Number.POSITIVE_INFINITY;
  let dryFrames = 0;
  let runStartMs: number | null = null;
  let runDeliveredMs = 0;
  let previousAtMs: number | null = null;
  for (const arrival of watch.spkArrivals) {
    if (previousAtMs !== null && arrival.atMs - previousAtMs > 1_500) runStartMs = null;
    if (runStartMs === null) {
      runStartMs = arrival.atMs;
      runDeliveredMs = 0;
    }
    const cushionMs = runDeliveredMs - (arrival.atMs - runStartMs);
    if (cushionMs < cushionMinMs) cushionMinMs = cushionMs;
    if (cushionMs < 0) dryFrames += 1;
    runDeliveredMs += arrival.payloadMs;
    previousAtMs = arrival.atMs;
  }
  const clumped = watch.spkArrivals.filter((arrival) => arrival.batchAudioFrames > 1).length;
  /* THREE CLOCKS ON ONE STREAM OF FRAMES. Provider→facet: the mirror's
   * receivedAtFacetMs per audio delta (every delta, silence included, so
   * expect ~100 ms). Facet send: sentAtFacetMs per speaker frame. Client
   * arrival: this driver's clock. Jitter that first appears at a later
   * clock was added by that hop. The transit spread (arrival minus send,
   * minus its own minimum so the clock offset cancels) is the delivery hop
   * alone. */
  const providerGaps = gapStats(watch.providerDeltaReceivedAtFacetMs);
  const sentGaps = gapStats(
    watch.spkArrivals
      .map((arrival) => arrival.sentAtFacetMs)
      .filter((value): value is number => value !== null),
  );
  const transits = watch.spkArrivals
    .filter((arrival) => arrival.sentAtFacetMs !== null)
    .map((arrival) => arrival.atMs - arrival.sentAtFacetMs!)
    .sort((a, b) => a - b);
  const transitBase = transits[0] ?? 0;
  const transitAt = (q: number) =>
    transits.length === 0
      ? 0
      : Math.round(
          transits[Math.min(transits.length - 1, Math.floor(q * transits.length))]! - transitBase,
        );
  const fmt = (g: ReturnType<typeof gapStats>) =>
    `p50 ${String(g.p50)} p90 ${String(g.p90)} p99 ${String(g.p99)} max ${String(g.max)} ms; >150 ms: ${String(g.over150)}, >250 ms: ${String(g.over250)} of ${String(g.count)}`;
  const appendLatencies = [...watch.micAppendLatenciesMs].sort((a, b) => a - b);
  const latencyAt = (q: number) =>
    appendLatencies.length === 0
      ? 0
      : appendLatencies[
          Math.min(appendLatencies.length - 1, Math.floor(q * appendLatencies.length))
        ]!;
  console.log(
    `    mic append round trip     p50 ${String(latencyAt(0.5))} p90 ${String(latencyAt(0.9))} p99 ${String(latencyAt(0.99))} max ${String(appendLatencies.at(-1) ?? 0)} ms over ${String(appendLatencies.length)} appends`,
  );
  console.log(`    provider→facet delta gaps ${fmt(providerGaps)}`);
  console.log(`    facet send gaps           ${fmt(sentGaps)}`);
  console.log(
    `    delivery transit spread   p50 +${String(transitAt(0.5))} p90 +${String(transitAt(0.9))} p99 +${String(transitAt(0.99))} max +${String(transitAt(1))} ms over the fastest frame`,
  );
  console.log(
    `    frame arrival gaps        p50 ${String(gaps.p50)} p90 ${String(gaps.p90)} p99 ${String(gaps.p99)} max ${String(gaps.max)} ms; >150 ms: ${String(gaps.over150)}, >250 ms: ${String(gaps.over250)} of ${String(gaps.count)}`,
  );
  console.log(
    `    frames arriving clumped   ${String(clumped)} of ${String(watch.spkArrivals.length)} shared a delivery batch with another audio frame`,
  );
  console.log(
    `    play-from-arrival cushion min ${String(Number.isFinite(cushionMinMs) ? Math.round(cushionMinMs) : "?")} ms; frames that would find the device dry: ${String(dryFrames)}`,
  );
  for (const line of watch.backendCalls) console.log(`  backend call ${line}`);
  console.log(`\n  heard:  ${watch.inputTranscript.trim().slice(0, 400)}`);
  console.log(`  said:   ${watch.outputTranscript.trim().slice(0, 600)}`);
  for (const note of notes) {
    /* backend-reply's payload is `{ text }` by the agent's contract. */
    console.log(
      `  backend: ${String((note.payload as { text?: string }).text ?? "").slice(0, 300)}`,
    );
  }
  console.log(`\n  verdict ${JSON.stringify(verdict)}`);
  if (Object.values(verdict).every((leg) => leg !== false)) {
    console.log(
      `\n  PASS: the session started, the mic never stopped, the voice answered, stopped when talked over, and the backend was heard.`,
    );
  } else {
    process.exitCode = 1;
  }
}
