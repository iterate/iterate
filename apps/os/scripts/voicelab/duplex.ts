// Full duplex through the platform, proven from the wire — no microphone, no
// speaker, no buttons anywhere, and a real GPT-Live on the far end.
//
//   doppler run --config dev_jonas -- pnpm cli voicelab duplex --project live1 --setup
//   doppler run --config prd -- pnpm cli voicelab duplex --project templestein \
//     --stream-path /agents/voice/duplex-1 --setup --backend-model gpt-6-astra
//
// The driver is the dumbest possible client: it appends microphone frames at
// realtime pace for the whole run (silence when it has nothing to say) and
// reads the speaker lane and the provider's mirror back. Everything below is
// read off the wire rather than assumed:
//
//   1. SESSION — the facet dialled GPT-Live and the session started: the
//      durable `session-configured` names the provider and the delegation
//      mode, `conversation-accepted` carries the handshake time.
//   2. FULL DUPLEX — the microphone never stops: frames flow up for the whole
//      run, including while answer frames flow down.
//   3. ANSWERS — a spoken request draws speech on the speaker lane, and each
//      answer ends with the facet's `lastFrameOfAnswer` marker (GPT-Live has
//      no end-of-answer event; the marker is inferred from silence).
//   4. IDLE DOWNLINK — between answers the speaker lane is QUIET: the
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
import {
  deliveredMsOf,
  FRAME_BYTES,
  FRAME_MS,
  openStream,
  sleep,
  synthesizeFrames,
} from "./probe-audio.ts";
import { talk } from "./talk.ts";

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
}

/** What an open microphone in a quiet room is: 20 ms of silence, forever. */
const SILENCE_FRAME = Buffer.alloc(FRAME_BYTES).toString("base64");

export async function duplex(options: DuplexOptions): Promise<void> {
  const streamPath =
    options.streamPath ??
    `/agents/voice/duplex-${new Date().toISOString().replace(/\D/g, "").slice(2, 12)}`;
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

  const stream = await openStream({ ...options, streamPath });
  const startedAtMs = Date.now();
  const clock = () => Date.now() - startedAtMs;

  /* Everything asserted below is collected from the wire by this listener. */
  let answersEnded = 0;
  let answerDeliveredMs = 0;
  let lastAudioFrameAtMs: number | null = null;
  let clearsSeen = 0;
  let spkFramesInQuietWindow = 0;
  let quietWindowOpen = false;
  let delegationCreatedAtMs: number | null = null;
  let delegationTarget: string | null = null;
  let backendFunctionCalls = 0;
  /** What the backend asked for and what the facet answered, off the mirror. */
  const backendCalls: string[] = [];
  let outputTranscript = "";
  let inputTranscript = "";
  let bargeSpokenAtMs: number | null = null;
  let firstAudioAfterDelegationAtMs: number | null = null;
  const connection = await stream.openConnection({
    connectionKey: `duplex-${Date.now()}`,
    eventTypes: [
      "events.iterate.com/voice-agent/spk-frame",
      "events.iterate.com/voice-agent/grok-event",
    ],
    processEventBatch: (batch: { events?: { type: string; payload?: unknown }[] }) => {
      for (const event of batch.events ?? []) {
        const payload = (event.payload ?? {}) as Record<string, unknown>;
        if (event.type === "events.iterate.com/voice-agent/spk-frame") {
          const pcm = typeof payload.pcm === "string" ? payload.pcm : "";
          if (quietWindowOpen) spkFramesInQuietWindow += 1;
          if (payload.clearSpeakerBufferBeforeFrame === true && pcm === "") clearsSeen += 1;
          if (payload.lastFrameOfAnswer === true) answersEnded += 1;
          if (pcm !== "") {
            answerDeliveredMs += deliveredMsOf(pcm);
            lastAudioFrameAtMs = clock();
            if (delegationCreatedAtMs !== null && firstAudioAfterDelegationAtMs === null) {
              firstAudioAfterDelegationAtMs = clock();
            }
          }
          continue;
        }
        const type = String(payload.type ?? "");
        if (type === "session.delegation.created") {
          delegationCreatedAtMs = clock();
          delegationTarget = String((payload.delegation as { target?: string })?.target ?? "");
        }
        if (type === "response.event") {
          const inner = (payload.event ?? {}) as {
            type?: string;
            item?: { type?: string; name?: string; arguments?: string };
          };
          if (inner.type === "response.output_item.done" && inner.item?.type === "function_call") {
            backendFunctionCalls += 1;
            backendCalls.push(
              `→ ${String(inner.item.name)}(${String(inner.item.arguments ?? "").slice(0, 200)})`,
            );
          }
        }
        if (type === "client.response.item.create") {
          backendCalls.push(`← ${String(payload.itemSummary ?? "").slice(0, 300)}`);
        }
        if (type === "session.output_transcript.delta") {
          outputTranscript += String(payload.delta ?? "");
        }
        if (type === "session.input_transcript.delta")
          inputTranscript += String(payload.delta ?? "");
      }
    },
  });

  /*
   * THE MICROPHONE NEVER STOPS. One realtime-paced loop feeds a queue of
   * utterance frames, padding with silence when the queue is empty.
   */
  let pending: string[] = [];
  let micFramesSent = 0;
  let stopMic = false;
  const speak = (frames: string[]) => {
    pending = pending.concat(frames);
  };
  const micLoop = (async () => {
    const startedAt = Date.now();
    let sequence = 0;
    while (!stopMic) {
      const due = startedAt + (sequence + 25) * FRAME_MS;
      const wait = due - Date.now();
      if (wait > 0) await sleep(wait);
      const events = [];
      for (let index = 0; index < 25; index++) {
        events.push({
          type: "events.iterate.com/voice-agent/mic-frame" as const,
          ephemeral: true as const,
          payload: { deviceMicFrameSeq: sequence, pcm: pending.shift() ?? SILENCE_FRAME },
        });
        sequence += 1;
      }
      micFramesSent += 25;
      void stream.append(...events).catch(() => undefined);
    }
  })();
  const waitFor = async (predicate: () => boolean, timeoutMs: number) => {
    const until = Date.now() + timeoutMs;
    while (!predicate() && Date.now() < until) await sleep(100);
    return predicate();
  };

  const verdict: Record<string, boolean | null> = {};
  const fail = (message: string) => {
    console.log(`  FAIL: ${message}`);
    process.exitCode = 1;
  };

  /* 1. SESSION: the first frames mint the call and dial. */
  console.log(`  open mic running on ${streamPath}; waiting for the session…`);
  await sleep(1_500);
  const accepted = await waitFor(
    () => micFramesSent > 0 && sessionAccepted(stream, startedAtMs),
    30_000,
  );
  verdict.session = accepted;
  if (!accepted) fail("the call never became live (no conversation-accepted)");

  /* 3/4/5. The counting answer, a quiet window is impossible mid-count, so
   * measure the idle downlink before speaking: the session is up and the
   * voice has nothing to say. */
  quietWindowOpen = true;
  await sleep(3_000);
  quietWindowOpen = false;
  verdict.idleDownlink = spkFramesInQuietWindow === 0;
  if (!verdict.idleDownlink)
    fail(`${String(spkFramesInQuietWindow)} speaker frames arrived while the voice was idle`);

  console.log(`  speaking the count request (${String(request.length)} frames)…`);
  speak(request);
  const counting = await waitFor(() => answerDeliveredMs >= bargeAfterMs, 60_000);
  if (!counting) fail(`only ${String(Math.round(answerDeliveredMs))}ms of answer arrived in 60s`);
  const answersBeforeBarge = answersEnded;
  const clearsBeforeBarge = clearsSeen;

  console.log(
    `  answer playing (${String(Math.round(answerDeliveredMs))}ms delivered); talking over it…`,
  );
  bargeSpokenAtMs = clock();
  speak(interjection);
  /* The voice should go quiet: no audio frame for 700 ms after the barge began. */
  const stopped = await waitFor(
    () =>
      lastAudioFrameAtMs !== null &&
      clock() - lastAudioFrameAtMs > 700 &&
      clock() > bargeSpokenAtMs! + 700,
    20_000,
  );
  const stoppedAfterBargeMs =
    stopped && lastAudioFrameAtMs !== null
      ? Math.max(0, lastAudioFrameAtMs - bargeSpokenAtMs)
      : null;
  const replied = await waitFor(() => answersEnded >= answersBeforeBarge + 2, 30_000);
  verdict.answers = answersEnded >= 2;
  verdict.barge = stoppedAfterBargeMs !== null && stoppedAfterBargeMs < 2_500 && replied;
  if (!verdict.barge) {
    fail(
      `barge: voice stopped ${String(stoppedAfterBargeMs)}ms after the interruption; answers ended ${String(answersEnded)} (wanted ≥ ${String(answersBeforeBarge + 2)})`,
    );
  }
  /* No clear is NEEDED on GPT-Live — the model yields itself — so a clear
   * here would only come from a button, which this driver has none of. */
  verdict.noClearNeeded = clearsSeen === clearsBeforeBarge;

  /* 7. DELEGATION. */
  if (options.skipDelegation !== true) {
    await waitFor(
      () => lastAudioFrameAtMs !== null && clock() - lastAudioFrameAtMs > 1_500,
      15_000,
    );
    console.log(`  asking something that needs the backend…`);
    const answersBefore = answersEnded;
    speak(delegation);
    const delegated = await waitFor(() => delegationCreatedAtMs !== null, 30_000);
    if (!delegated) fail("no session.delegation.created within 30s of the request");
    else
      console.log(
        `  delegation created (target ${String(delegationTarget)}); waiting for the backend…`,
      );
    const answeredByBackend = await waitFor(
      () =>
        delegationCreatedAtMs !== null &&
        backendFunctionCalls > 0 &&
        answersEnded > answersBefore + 1,
      delegationTimeoutMs,
    );
    verdict.delegation = delegated && answeredByBackend;
    if (!answeredByBackend) {
      fail(
        `the backend's reply never reached the voice (function calls ${String(backendFunctionCalls)}, answers ended ${String(answersEnded)})`,
      );
    }
    await waitFor(
      () => lastAudioFrameAtMs !== null && clock() - lastAudioFrameAtMs > 1_500,
      30_000,
    );
  }

  stopMic = true;
  await micLoop;
  connection.close();
  /* Let the durable transcript appends land. */
  await sleep(2_500);

  /* 6. TRANSCRIPT: durable, readable after the fact. */
  const durable = await readVoiceEvents(stream, startedAtMs);
  const utterances = durable.filter((e) => e.type.endsWith("/utterance-transcript"));
  const answers = durable.filter((e) => e.type.endsWith("/answer-transcript"));
  const notes = durable.filter((e) => e.type.endsWith("/backend-reply"));
  verdict.transcript = utterances.length >= 2 && answers.length >= 2;
  if (!verdict.transcript) {
    fail(
      `transcript: ${String(utterances.length)} utterances, ${String(answers.length)} answers on the stream`,
    );
  }
  verdict.duplex = micFramesSent > 0;

  console.log(`\n  FULL DUPLEX THROUGH THE PLATFORM (GPT-Live)`);
  console.log(
    `    mic frames sent           ${String(micFramesSent)} (continuous, zero ptt verbs)`,
  );
  console.log(
    `    idle speaker frames       ${String(spkFramesInQuietWindow)} in a 3 s quiet window`,
  );
  console.log(`    answers ended (markers)   ${String(answersEnded)}`);
  console.log(`    answer audio delivered    ${String(Math.round(answerDeliveredMs))}ms`);
  console.log(`    voice stopped after barge ${String(stoppedAfterBargeMs)}ms`);
  console.log(`    clears                    ${String(clearsSeen)}`);
  console.log(
    `    delegation                ${delegationCreatedAtMs === null ? "none" : `${String(delegationTarget)}, first speech ${String(firstAudioAfterDelegationAtMs === null ? "?" : firstAudioAfterDelegationAtMs - delegationCreatedAtMs)}ms after it`}`,
  );
  console.log(`    backend function calls    ${String(backendFunctionCalls)}`);
  console.log(
    `    durable transcript        ${String(utterances.length)} utterances, ${String(answers.length)} answers, ${String(notes.length)} backend notes`,
  );
  for (const line of backendCalls) console.log(`  backend call ${line}`);
  console.log(`\n  heard:  ${inputTranscript.trim().slice(0, 400)}`);
  console.log(`  said:   ${outputTranscript.trim().slice(0, 600)}`);
  for (const note of notes) {
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

let cachedAccepted = false;
function sessionAccepted(stream: unknown, sinceMs: number): boolean {
  if (cachedAccepted) return true;
  void readVoiceEvents(stream, sinceMs).then((events) => {
    if (events.some((event) => event.type.endsWith("/conversation-accepted")))
      cachedAccepted = true;
  });
  return cachedAccepted;
}

/** The stream handle's read surface the verdict needs. */
interface VoiceStreamReads {
  getEvents(input: {
    afterOffset: number;
    eventTypes?: string[];
    limit: number;
  }): Promise<{ type: string; createdAt: string; payload?: unknown }[]>;
}

async function readVoiceEvents(stream: unknown, sinceMs: number) {
  const readable = stream as unknown as VoiceStreamReads;
  const events = await readable.getEvents({
    afterOffset: 0,
    eventTypes: [
      "events.iterate.com/voice-agent/conversation-accepted",
      "events.iterate.com/voice-agent/session-configured",
      "events.iterate.com/voice-agent/utterance-transcript",
      "events.iterate.com/voice-agent/answer-transcript",
      "events.iterate.com/voice-agent/backend-reply",
    ],
    limit: 500,
  });
  return (events ?? []).filter((event) => Date.parse(event.createdAt) >= sinceMs - 5_000);
}
