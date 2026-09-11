// Prove every connected board end to end, out loud, through real air.
//
// The other device scripts here drive ONE board and mostly read counters. This
// one asks the whole question a person asks: can I say something to this thing
// and have it answer? So it speaks the prompt out of the Mac's own SPEAKER and
// requires the board's own MICROPHONE to have heard it — nothing is injected
// past the hardware, because the hardware is what keeps breaking.
//
// A pass needs four separate facts, and no counter here can be true for the
// wrong reason on its own:
//
//   a. the call became active (and how long that took, which is the thing
//      people complain about);
//   b. microphone frames actually left the device (`framesSent`);
//   c. an answer actually reached its speaker (`spkWrites`, `spkAnswerStarts`);
//   d. the provider transcribed the spoken words and the board answered them.
//
//   doppler run --config prd -- pnpm cli voicelab boards --project voice-test
//   doppler run --config prd -- pnpm cli voicelab boards --project voice-test --only stackchan
import { execFile } from "node:child_process";
import fs from "node:fs";
import process from "node:process";
import { promisify } from "node:util";
import {
  type VoicelabConnectOptions,
  connectProject,
  deviceCapability,
  deviceClientPath,
} from "./connect.ts";

const run = promisify(execFile);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Options for `pnpm cli voicelab boards`. */
export interface BoardsOptions extends VoicelabConnectOptions {
  /** Capability name of a single board to prove; omit to prove all of them. */
  only?: string;
  /** What to say out loud. Must be something a one-word answer can follow. */
  prompt?: string;
  /** The word the answer has to contain for the transcript check to pass. */
  expect?: string;
  /** Where to write the evidence JSON. */
  out?: string;
  /**
   * Speak a second time OVER the first answer, and check the device reacts.
   *
   * The one-turn proof above cannot see the failure people actually report,
   * which is not "the device is silent" but "it talks over me and will not
   * stop". That needs two utterances where the second lands while the speaker
   * is still playing the first, and it needs the DEVICE's own barge-in
   * counters as the witness — a transcript cannot tell you whether the board
   * stopped playing, only what the model eventually said.
   */
  barge?: boolean;
  /**
   * Wake the board by SAYING its wake word instead of pressing its button.
   *
   * The hands-free path is a different path: WakeNet on the board hears the
   * Mac, the shared grammar gets a synthetic tap, the chime plays, and only
   * then does a call start. A press-driven pass proves none of that. The
   * word is spoken through the same speaker the prompt is.
   */
  wakeWord?: string;
}

const BOARDS = [
  "stackchan",
  "m5stick-s3",
  "home-assistant-voice-preview-edition",
  "satellite1",
  "waveshare",
];

/** What one board's attempt produced. Written out whole, pass or fail. */
interface BoardResult {
  label: string;
  verdict: string;
  callActiveMs?: number | null;
  streamPath?: string;
  /** Second-utterance evidence, present only when --barge ran. */
  barge?: {
    /** Playback was live when the second utterance began. */
    speakerPlayingAtInterruption: boolean;
    /** Speaker writes observed during the short window before the interruption. */
    freshSpeakerWritesBeforeInterruption: number;
    /** Answers the device abandoned mid-play, which is what stopping IS. */
    superseded: number;
    /** The provider transcribed the interruption through the board microphone. */
    interruptionHeard: boolean;
    /** A provider response was created after the interruption and has an id. */
    newResponseStarted: boolean;
    /** The post-interruption response's own transcript contains the requested word. */
    answerMentionsPineapple: boolean;
    /** Fresh answer audio reached the speaker after the interruption. */
    playbackRestarted: boolean;
    /** A new answer, containing the requested word, played after the interruption. */
    interruptionAnswered: boolean;
    /** Baselines and deltas that make the second-turn conclusion auditable. */
    responseCreatedCountBefore: number;
    responseCreatedCountAfter: number;
    postInterruptionResponseId?: string;
    speakerWritesBefore: number;
    speakerWritesAfter: number;
    freshSpeakerWritesAfterInterruption: number;
    answerStartsBefore: number;
    answerStartsAfter: number;
    freshAnswerStartsAfterInterruption: number;
    speakerFramesPlayedBefore: number;
    speakerFramesPlayedAfter: number;
    freshSpeakerFramesPlayedAfterInterruption: number;
    speakerGenerationBefore: number;
    speakerGenerationAfter: number;
    lastPlayedSpeakerGenerationAfter: number;
    verdict: string;
  };
  deviceHeard?: string;
  deviceSaid?: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  preEndHealth?: Record<string, unknown>;
  finalHealth?: Record<string, unknown>;
}

/** The health contract makes an unavailable or malformed metric a failed proof. */
function healthCounter(health: Record<string, unknown>, name: string): number {
  const value = health[name];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`health() must report ${name} as a non-negative integer`);
  }
  return value;
}

function healthFlag(health: Record<string, unknown>, name: string): boolean {
  const value = health[name];
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  throw new Error(`health() must report ${name} as a boolean or 0/1 flag`);
}

interface ProofHealth {
  framesSent: number;
  spkWrites: number;
  spkAnswerStarts: number;
  speakerPlaying: boolean;
  wakeWordDetections?: number;
}

function proofHealth(health: Record<string, unknown>, requireWakeWord: boolean): ProofHealth {
  return {
    framesSent: healthCounter(health, "framesSent"),
    spkWrites: healthCounter(health, "spkWrites"),
    spkAnswerStarts: healthCounter(health, "spkAnswerStarts"),
    speakerPlaying: healthFlag(health, "speakerPlaying"),
    ...(requireWakeWord && { wakeWordDetections: healthCounter(health, "wakeWordDetections") }),
  };
}

function promptWasTranscribed(prompt: string, transcript: string): boolean {
  const promptWords = [...new Set(prompt.toLowerCase().match(/[a-z0-9]+/g) ?? [])];
  const transcriptWords = new Set(transcript.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  const matchedWords = promptWords.filter((word) => transcriptWords.has(word)).length;
  const requiredWords =
    promptWords.length < 3 ? promptWords.length : Math.ceil(promptWords.length * 0.8);
  return matchedWords >= requiredWords;
}

function requireProofText(value: string, name: string): string {
  const text = value.trim();
  if (!/[a-z0-9]/i.test(text)) {
    throw new Error(`${name} must contain at least one letter or number`);
  }
  return text;
}

function appendFailure(record: BoardResult, reason: string) {
  record.verdict = record.verdict === "PASS" ? `FAIL: ${reason}` : `${record.verdict}; ${reason}`;
}

/** End every proof in a verifiably idle, still-running device state. */
async function endAndVerifyCall(
  kit: BoardCapability,
  record: BoardResult,
  before: Record<string, unknown> | undefined,
  pushToTalk: boolean | undefined,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  let preEnd: Record<string, unknown> | undefined;
  let preEndError: unknown;
  try {
    preEnd = await healthWithRetry(kit, 20, deadline);
    record.preEndHealth = preEnd;
  } catch (error) {
    preEndError = error;
  }
  let endError: unknown;
  try {
    await kit.conversation.end();
  } catch (error) {
    // A call can have ended on its own; only the observed idle state can make
    // that expected. Keep the RPC error as evidence until the state proves it.
    endError = error;
  }

  let minimumUptime = 0;
  let beforeWakeFrames: number | undefined;
  try {
    const beforeUptime = before === undefined ? 0 : healthCounter(before, "uptimeMs");
    const preEndUptime = preEnd === undefined ? 0 : healthCounter(preEnd, "uptimeMs");
    minimumUptime = Math.max(beforeUptime, preEndUptime);
    const wakeModel =
      preEnd?.wakeWordModel === undefined ? 0 : healthCounter(preEnd, "wakeWordModel");
    if (wakeModel === 1 && !pushToTalk && preEnd !== undefined) {
      beforeWakeFrames = healthCounter(preEnd, "wakeWordFrames");
    }
  } catch (error) {
    preEndError ??= error;
  }
  let last: Record<string, unknown> | undefined;
  let stateError: string | undefined;

  for (let attempt = 0; attempt < 30 && Date.now() < deadline; attempt++) {
    try {
      const health = await healthWithRetry(kit, 20, deadline);
      last = health;
      record.finalHealth = health;
      const idle =
        !healthFlag(health, "callActive") &&
        !healthFlag(health, "callPending") &&
        !healthFlag(health, "wantsCall");
      const uptimeMonotonic = healthCounter(health, "uptimeMs") >= minimumUptime;
      const wakeResumed =
        beforeWakeFrames === undefined ||
        healthCounter(health, "wakeWordFrames") > beforeWakeFrames;
      if (preEndError === undefined && idle && uptimeMonotonic && wakeResumed) {
        if (endError !== undefined) {
          record.finalHealth = { ...health, endError: String(endError) };
          if (!/already (?:ended|gone|inactive)|no active call/i.test(String(endError))) {
            appendFailure(record, `hangup RPC failed despite idle health: ${String(endError)}`);
          }
        }
        return;
      }
      stateError = [
        !idle && "device did not become idle",
        preEndError !== undefined && `could not read pre-end health: ${String(preEndError)}`,
        !uptimeMonotonic && "device restarted during hangup",
        !wakeResumed && "wake-word processing did not resume",
      ]
        .filter(Boolean)
        .join(", ");
    } catch (error) {
      stateError = `could not read final health: ${String(error)}`;
    }
    await sleep(Math.min(500, Math.max(0, deadline - Date.now())));
  }

  const evidence = last === undefined ? "no final health" : JSON.stringify(last);
  const endDetail = endError === undefined ? "" : `; end() failed: ${String(endError)}`;
  appendFailure(
    record,
    `hangup failed: ${stateError ?? "idle deadline elapsed"}${endDetail}; final=${evidence}`,
  );
}

/**
 * Reads health across a remount.
 *
 * Adopting a fresh conversation REMOUNTS the device, and for a second or two
 * its capability genuinely is not there. That is the handshake working, not a
 * broken board, so every read rides over it instead of reporting a device that
 * is in fact fine.
 */
async function healthWithRetry(
  kit: { health(): Promise<Record<string, unknown>> },
  attempts = 20,
  deadline = Number.POSITIVE_INFINITY,
): Promise<Record<string, unknown>> {
  let last: unknown;
  for (let attempt = 0; attempt < attempts && Date.now() < deadline; attempt++) {
    try {
      return await kit.health();
    } catch (error) {
      last = error;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      await sleep(Math.min(1500, remainingMs));
    }
  }
  throw last ?? new Error("health() retry deadline elapsed");
}

/** Wait until the call's greeting has both played and remained quiet for two seconds. */
async function waitForGreetingToSettle(
  kit: { health(): Promise<Record<string, unknown>> },
  requireWakeWord: boolean,
  greetingRequired: boolean,
): Promise<ProofHealth> {
  const deadline = Date.now() + 60_000;
  let previous = proofHealth(await healthWithRetry(kit, 20, deadline), requireWakeWord);
  let greetingObserved = !greetingRequired || previous.speakerPlaying || previous.spkWrites > 0;
  let quietSamples = 0;

  for (let attempt = 0; attempt < 120 && Date.now() < deadline; attempt++) {
    await sleep(Math.min(500, deadline - Date.now()));
    const current = proofHealth(await healthWithRetry(kit, 20, deadline), requireWakeWord);
    const speakerWriteProgressed = current.spkWrites > previous.spkWrites;
    if (current.speakerPlaying || speakerWriteProgressed) {
      greetingObserved = true;
      quietSamples = 0;
    } else if (greetingObserved) {
      quietSamples += 1;
      if (quietSamples === 4) return current;
    }
    previous = current;
  }

  throw new Error(
    greetingObserved
      ? "greeting playback did not remain quiet before the prompt"
      : "configured greeting playback was never observed before the prompt",
  );
}

interface BoardCapability {
  health(): Promise<Record<string, unknown>>;
  conversation: {
    start(): Promise<void>;
    end(): Promise<void>;
  };
  pushToTalk: {
    start(): Promise<void>;
    stop(): Promise<void>;
  };
}

/** Prove the selected boards through their microphones and speakers. */
export async function boards(options: BoardsOptions) {
  const prompt = requireProofText(
    options.prompt ??
      (options.barge
        ? "Tell a detailed story for at least thirty seconds about a banana. Keep speaking until asked to stop."
        : "Hello there. Please reply with the single word banana."),
    "prompt",
  );
  const expect = requireProofText(options.expect ?? "banana", "expect").toLowerCase();
  // deviceClientPath resolves aliases and arbitrary --only names alike.
  const chosen = options.only ? [options.only] : BOARDS;
  const results: Record<string, BoardResult> = {};

  for (const board of chosen) {
    const record: BoardResult = { label: board, verdict: "FAIL: did not run" };
    results[board] = record;
    console.error(`\n=== ${board} (${deviceClientPath(board)}) ===`);
    /* One connection per board: a socket that died proving the last board must
     * not be reported as this board's fault. */
    using itx = await connectProject(options);
    const kit = deviceCapability<BoardCapability>(itx, board);
    let beforeForHangup: Record<string, unknown> | undefined;
    let pushToTalkForHangup: boolean | undefined;
    let connection: { close(): void | Promise<void> } | undefined;

    try {
      const before = await healthWithRetry(kit);
      beforeForHangup = before;
      const beforeProof = proofHealth(before, options.wakeWord !== undefined);
      const pushToTalk = before.pushToTalk;
      if (typeof pushToTalk !== "boolean") {
        throw new Error("health() must report pushToTalk as a boolean");
      }
      pushToTalkForHangup = pushToTalk;
      if (healthFlag(before, "callActive")) {
        throw new Error("call was already active before this proof began");
      }
      record.before = {
        ...beforeProof,
        callActive: before.callActive,
        spkFrames: before.spkFrames,
        spkPlayed: before.spkPlayed,
        spkSupersededMidplay: before.spkSupersededMidplay,
        wakeWordDetections: before.wakeWordDetections,
        uptimeMs: before.uptimeMs,
      };

      /* Subscribe before asking for the call: session-configured is the
       * current call's contract, and a late subscription cannot safely infer
       * whether silence is a missing greeting or the configured behaviour. */
      const streamPath = String(before.conversation ?? "");
      record.streamPath = streamPath;
      let heardUs = "";
      let saidBack = "";
      let responsesCreated = 0;
      const responseIdsCreated: string[] = [];
      const transcriptByResponseId = new Map<string, string>();
      let greetingConfigured: boolean | undefined;
      connection = await itx.streams.get(streamPath).openConnection({
        connectionKey: `boards-${board}-${Date.now()}`,
        eventTypes: [
          "events.iterate.com/voice-agent/grok-event",
          "events.iterate.com/voice-agent/session-configured",
        ],
        processEventBatch: (batch: { events?: { type?: string; payload?: unknown }[] }) => {
          for (const event of batch.events ?? []) {
            const payload = (event.payload ?? {}) as {
              event?: {
                type?: string;
                delta?: string;
                transcript?: string;
                greeting?: unknown;
                response_id?: string;
                response?: { id?: string };
              };
              type?: string;
              delta?: string;
              transcript?: string;
              greeting?: unknown;
              response_id?: string;
              response?: { id?: string };
            };
            const inner = payload.event ?? payload;
            if (event.type === "events.iterate.com/voice-agent/session-configured") {
              if (typeof payload.greeting !== "boolean") {
                throw new Error("session-configured must report greeting as a boolean");
              }
              greetingConfigured = payload.greeting;
            }
            if (inner?.type === "response.created") {
              responsesCreated += 1;
              if (typeof inner.response?.id === "string")
                responseIdsCreated.push(inner.response.id);
            }
            if (inner?.type === "response.output_audio_transcript.delta") {
              saidBack += inner.delta ?? "";
              if (typeof inner.response_id === "string" && typeof inner.delta === "string") {
                transcriptByResponseId.set(
                  inner.response_id,
                  (transcriptByResponseId.get(inner.response_id) ?? "") + inner.delta,
                );
              }
            }
            if (inner?.type?.endsWith("input_audio_transcription.completed")) {
              heardUs += (heardUs === "" ? "" : "\n") + (inner.transcript ?? "");
            }
          }
        },
      });

      const askedAt = Date.now();
      if (options.wakeWord) {
        console.error(`  saying "${options.wakeWord}"`);
        await run("say", ["-r", "170", `${options.wakeWord}.`]);
      } else {
        await kit.conversation.start();
      }

      let callActiveMs: number | null = null;
      let wakeWordDetected = options.wakeWord === undefined;
      let callActiveBeforeWakeWord = false;
      const wakeWordDetectionsBefore = beforeProof.wakeWordDetections;
      for (let attempt = 0; attempt < 60; attempt++) {
        const health = await healthWithRetry(kit);
        if (options.wakeWord) {
          if (wakeWordDetectionsBefore === undefined) {
            throw new Error("wake-word proof has no wakeWordDetections baseline");
          }
          wakeWordDetected = healthCounter(health, "wakeWordDetections") > wakeWordDetectionsBefore;
        }
        const callActive = healthFlag(health, "callActive");
        if (callActive && !wakeWordDetected) callActiveBeforeWakeWord = true;
        if (callActive && wakeWordDetected && !callActiveBeforeWakeWord) {
          callActiveMs = Date.now() - askedAt;
          break;
        }
        await sleep(500);
      }
      record.callActiveMs = callActiveMs;
      console.error(`  call active after ${callActiveMs} ms`);
      if (callActiveMs === null) {
        record.verdict = options.wakeWord
          ? "FAIL: wake-word detection did not precede a new active call"
          : "FAIL: call never became active";
        await connection.close();
        connection = undefined;
        continue;
      }

      const configuredDeadline = Date.now() + 15_000;
      while (greetingConfigured === undefined && Date.now() < configuredDeadline) {
        await sleep(Math.min(500, configuredDeadline - Date.now()));
      }
      if (greetingConfigured === undefined) {
        await connection.close();
        connection = undefined;
        throw new Error("current call never emitted session-configured");
      }

      try {
        /* A new call resets `spkWrites`; its old idle value is not evidence
         * against this prompt. Wait for this call's greeting to settle, then
         * snapshot immediately before the words this proof is about. */
        const promptBefore = await waitForGreetingToSettle(
          kit,
          options.wakeWord !== undefined,
          greetingConfigured,
        );
        record.before = { ...record.before, promptBefore };
        // Greeting/provider events belong to call setup, never to this prompt.
        heardUs = "";
        saidBack = "";
        responsesCreated = 0;
        responseIdsCreated.length = 0;
        transcriptByResponseId.clear();
        if (pushToTalk) await kit.pushToTalk.start();
        await run("say", ["-r", "170", prompt]);
        if (pushToTalk) await kit.pushToTalk.stop();

        let audioMoved = false;
        let speakerPlayed = false;
        let promptTranscribed = false;
        let answerTranscribed = false;
        for (let attempt = 0; attempt < 40; attempt++) {
          const health = await healthWithRetry(kit);
          const current = proofHealth(health, options.wakeWord !== undefined);
          record.after = {
            batches: health.batches,
            ...current,
            micCaptured: health.micCaptured,
            micDropped: health.micDropped,
            spkFrames: health.spkFrames,
            spkPlayed: health.spkPlayed,
            spkSupersededMidplay: health.spkSupersededMidplay,
            spkStarvedMs: health.spkStarvedMs,
            framesSentDelta: current.framesSent - promptBefore.framesSent,
            spkWritesDelta: current.spkWrites - promptBefore.spkWrites,
            spkAnswerStartsDelta: current.spkAnswerStarts - promptBefore.spkAnswerStarts,
          };
          audioMoved =
            current.framesSent > promptBefore.framesSent &&
            current.spkWrites > promptBefore.spkWrites &&
            current.spkAnswerStarts > promptBefore.spkAnswerStarts;
          speakerPlayed ||= current.speakerPlaying;
          promptTranscribed ||= promptWasTranscribed(prompt, heardUs);
          answerTranscribed ||= saidBack.toLowerCase().includes(expect);
          /* The stream's transcriptions arrive behind playback. Do not call a
           * passing physical exchange a failure just because one requested
           * transcript has not reached this already-open collector yet. In a
           * barge proof this still stops at the first qualifying evidence; it
           * never waits for the long first answer to finish. */
          if (audioMoved && speakerPlayed && promptTranscribed && answerTranscribed) {
            break;
          }
          await sleep(500);
        }
        console.error(`  ${JSON.stringify(record.after)}`);
        record.deviceHeard = heardUs.trim();
        record.deviceSaid = saidBack.trim();
        promptTranscribed ||= promptWasTranscribed(prompt, heardUs);
        answerTranscribed ||= saidBack.toLowerCase().includes(expect);
        /*
         * "audio only" is deliberately not a pass. Frames moving in both
         * directions proves the lanes are alive; it does not prove the device
         * understood anything, and those are different claims.
         */
        record.verdict =
          audioMoved && speakerPlayed && promptTranscribed && answerTranscribed
            ? "PASS"
            : "FAIL: incomplete physical evidence";
        console.error(`  heard: ${JSON.stringify(record.deviceHeard)}`);
        console.error(`  said:  ${JSON.stringify(record.deviceSaid)}`);
        console.error(`  ${record.verdict}  stream=${streamPath}`);

        if (options.barge === true && record.verdict === "PASS") {
          /*
           * THE SECOND TURN, spoken deliberately EARLY.
           *
           * The point is to be talking while the board is talking, so the
           * prompt above must be one with a long answer and this must not
           * wait for it to finish. `spkAnswerStarts` at the moment of the
           * interruption is recorded so the evidence says whether playback
           * was actually in flight — an interruption of silence proves
           * nothing and must not be allowed to look like a pass.
           */
          const playbackBeforeWindow = await healthWithRetry(kit);
          await sleep(500);
          const playbackAtInterruption = await healthWithRetry(kit);
          const duringProof = proofHealth(playbackAtInterruption, options.wakeWord !== undefined);
          const freshSpeakerWrites =
            duringProof.spkWrites -
            proofHealth(playbackBeforeWindow, options.wakeWord !== undefined).spkWrites;
          if (!duringProof.speakerPlaying || freshSpeakerWrites <= 0) {
            record.barge = {
              speakerPlayingAtInterruption: duringProof.speakerPlaying,
              freshSpeakerWritesBeforeInterruption: freshSpeakerWrites,
              superseded: 0,
              newResponseStarted: false,
              answerMentionsPineapple: false,
              playbackRestarted: false,
              interruptionHeard: false,
              interruptionAnswered: false,
              responseCreatedCountBefore: responsesCreated,
              responseCreatedCountAfter: responsesCreated,
              speakerWritesBefore: duringProof.spkWrites,
              speakerWritesAfter: duringProof.spkWrites,
              freshSpeakerWritesAfterInterruption: 0,
              answerStartsBefore: duringProof.spkAnswerStarts,
              answerStartsAfter: duringProof.spkAnswerStarts,
              freshAnswerStartsAfterInterruption: 0,
              speakerFramesPlayedBefore: healthCounter(playbackAtInterruption, "spkPlayed"),
              speakerFramesPlayedAfter: healthCounter(playbackAtInterruption, "spkPlayed"),
              freshSpeakerFramesPlayedAfterInterruption: 0,
              speakerGenerationBefore: healthCounter(
                playbackAtInterruption,
                "spkSpeakerGeneration",
              ),
              speakerGenerationAfter: healthCounter(playbackAtInterruption, "spkSpeakerGeneration"),
              lastPlayedSpeakerGenerationAfter: healthCounter(
                playbackAtInterruption,
                "spkLastPlayedGeneration",
              ),
              verdict: "FAIL: no fresh speaker write during the interruption window",
            };
            record.verdict = "FAIL: barge proof had no active playback to interrupt";
          } else {
            const startsBefore = duringProof.spkAnswerStarts;
            const writesBefore = duringProof.spkWrites;
            const playedBefore = healthCounter(playbackAtInterruption, "spkPlayed");
            const speakerGenerationBefore = healthCounter(
              playbackAtInterruption,
              "spkSpeakerGeneration",
            );
            const supersededBefore = healthCounter(playbackAtInterruption, "spkSupersededMidplay");
            const responsesBefore = responsesCreated;
            const responseIdsBefore = new Set(responseIdsCreated);
            const heardBefore = heardUs.length;

            if (pushToTalk) await kit.pushToTalk.start();
            await run("say", ["-r", "170", "Stop. Say the word pineapple instead."]);
            if (pushToTalk) await kit.pushToTalk.stop();

            /* A response id is the attribution boundary. Character offsets cannot
             * distinguish a late delta from the barged answer from a delta of the
             * reply we asked for; provider response ids can. */
            let interruptionAnswered = false;
            let interruptionHeard = false;
            let newResponseStarted = false;
            let answerMentionsPineapple = false;
            let playbackRestarted = false;
            let superseded = 0;
            let responseId: string | undefined;
            let latest = playbackAtInterruption;
            for (let attempt = 0; attempt < 30; attempt++) {
              const health = await healthWithRetry(kit);
              const current = proofHealth(health, options.wakeWord !== undefined);
              latest = health;
              superseded = healthCounter(health, "spkSupersededMidplay") - supersededBefore;
              responseId ??= responseIdsCreated.find((id) => !responseIdsBefore.has(id));
              newResponseStarted ||= responseId !== undefined;
              interruptionHeard ||= heardUs.slice(heardBefore).toLowerCase().includes("pineapple");
              answerMentionsPineapple ||=
                responseId !== undefined &&
                (transcriptByResponseId.get(responseId) ?? "").toLowerCase().includes("pineapple");
              /* A one-word reply can play fully between one-second polls. The
               * board preserves the generation of the last frame its codec
               * accepted, so a stale old-tail frame cannot count as this reply. */
              playbackRestarted ||=
                current.spkAnswerStarts > startsBefore &&
                current.spkWrites > writesBefore &&
                healthCounter(health, "spkSpeakerGeneration") > speakerGenerationBefore &&
                healthCounter(health, "spkLastPlayedGeneration") ===
                  healthCounter(health, "spkSpeakerGeneration");
              if (
                newResponseStarted &&
                interruptionHeard &&
                answerMentionsPineapple &&
                playbackRestarted
              ) {
                break;
              }
              await sleep(1000);
            }
            /*
             * HOLD THE HANG-UP for the evidence still in flight: the barge
             * utterance's own transcription completes seconds after its
             * commit, and the second answer's transcript is still streaming.
             */
            for (let grace = 0; grace < 10 && heardUs.length <= heardBefore; grace++) {
              await sleep(1000);
            }
            responseId ??= responseIdsCreated.find((id) => !responseIdsBefore.has(id));
            newResponseStarted ||= responseId !== undefined;
            interruptionHeard ||= heardUs.slice(heardBefore).toLowerCase().includes("pineapple");
            answerMentionsPineapple ||=
              responseId !== undefined &&
              (transcriptByResponseId.get(responseId) ?? "").toLowerCase().includes("pineapple");
            interruptionAnswered =
              newResponseStarted &&
              interruptionHeard &&
              answerMentionsPineapple &&
              playbackRestarted;
            /*
             * Two separate claims, kept separate. "It heard me while it was
             * talking" is the barge-in; "it then said something new" is the
             * second turn. A board that stops but never answers again is a
             * different defect from one that answers without ever stopping.
             *
             * THERE WERE THREE COLUMNS AND ONLY TWO CLAIMS. `bargeIns` stood
             * beside `superseded` and reported what `answeredAgain` already did:
             * the firmware incremented it on the `drop` that STARTS an answer, so
             * it moved once per reply whether or not anything was interrupted.
             * The counter is gone from the device; what is left here is the
             * honest pair — audio was thrown away mid-play, and a new answer
             * arrived.
             */
            const noticed = superseded > 0;
            record.barge = {
              speakerPlayingAtInterruption: duringProof.speakerPlaying,
              freshSpeakerWritesBeforeInterruption: freshSpeakerWrites,
              superseded,
              newResponseStarted,
              answerMentionsPineapple,
              playbackRestarted,
              interruptionHeard,
              interruptionAnswered,
              responseCreatedCountBefore: responsesBefore,
              responseCreatedCountAfter: responsesCreated,
              ...(responseId !== undefined && { postInterruptionResponseId: responseId }),
              speakerWritesBefore: writesBefore,
              speakerWritesAfter: healthCounter(latest, "spkWrites"),
              freshSpeakerWritesAfterInterruption:
                healthCounter(latest, "spkWrites") - writesBefore,
              answerStartsBefore: startsBefore,
              answerStartsAfter: healthCounter(latest, "spkAnswerStarts"),
              freshAnswerStartsAfterInterruption:
                healthCounter(latest, "spkAnswerStarts") - startsBefore,
              speakerFramesPlayedBefore: playedBefore,
              speakerFramesPlayedAfter: healthCounter(latest, "spkPlayed"),
              freshSpeakerFramesPlayedAfterInterruption:
                healthCounter(latest, "spkPlayed") - playedBefore,
              speakerGenerationBefore,
              speakerGenerationAfter: healthCounter(latest, "spkSpeakerGeneration"),
              lastPlayedSpeakerGenerationAfter: healthCounter(latest, "spkLastPlayedGeneration"),
              verdict:
                noticed && interruptionAnswered
                  ? "PASS"
                  : interruptionAnswered
                    ? "FAIL: a new answer played but the device logged no interruption"
                    : noticed
                      ? "FAIL: stopped for the interruption but did not prove a new answer"
                      : "FAIL: talked straight through the interruption",
            };
            if (record.barge.verdict !== "PASS") record.verdict = `FAIL: ${record.barge.verdict}`;
            console.error(
              `  barge: superseded+${String(superseded)} ` +
                `heard=${String(interruptionHeard)} answered=${String(interruptionAnswered)} — ${record.barge.verdict}`,
            );
            /* Both refreshed: the collector ran through the barge window, so
             * the evidence carries the barge utterance and the second answer,
             * not a snapshot from before either existed. */
            record.deviceHeard = heardUs.trim();
            record.deviceSaid = saidBack.trim();
          }
        }
      } finally {
        await connection.close();
        connection = undefined;
      }
    } catch (error) {
      record.verdict = `FAIL: ${String(error).slice(0, 200)}`;
      console.error(`  ${record.verdict}`);
    } finally {
      if (connection !== undefined) await connection.close();
      await endAndVerifyCall(kit, record, beforeForHangup, pushToTalkForHangup);
    }
  }

  if (options.out) fs.writeFileSync(options.out, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  if (Object.values(results).some((result) => result.verdict !== "PASS")) process.exitCode = 1;
  return results;
}
