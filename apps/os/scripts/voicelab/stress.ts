// A long conversation, with long answers in it, against a real device.
//
// `soak` proves a call SURVIVES: it holds one open for an hour and pings it
// with a short question every 45s. It passed — 39 turns, 26 minutes, nothing
// moved. But every one of those turns was a sentence and a half of audio, and
// a sentence and a half never fills a playout ring, never makes the heap work,
// and never asks the device to play unbroken sound for a minute at a time. A
// device can pass that test all day and still truncate the first long answer a
// person ever asks it for.
//
// So this is the same conversation, made HARD in the two dimensions soak left
// alone: MANY consecutive turns (100+), and LONG continuous audio (count to a
// hundred; four hundred words about a lighthouse). Turns are mixed and
// deliberately conversational — some of them can only be answered by
// remembering something said forty minutes earlier — because a queue of
// unrelated prompts does not test a conversation.
//
// Everything measured is measured per turn AND per class, so the report can
// answer the question that matters: do the failures cluster in the long ones?
//
//   doppler run --config preview_3 -- pnpm cli voicelab stress \
//     --project prj_… --path /agents/voice/dev-… --turns 120 --minutes 90 \
//     --out /tmp/stress.json
import fs from "node:fs";

import { bringCallUp, waitForQuietPlayout } from "./call.ts";
import { connectProject, type VoicelabConnectOptions } from "./connect.ts";
import {
  counterDelta,
  DAMAGE_MUST_NOT_MOVE,
  type DeviceStats,
  FRAME_BYTES,
  FRAME_MS,
  movedCounters,
  MUST_NOT_MOVE,
  slopePerStep,
  spread,
  TOLERATED_COUNTERS,
} from "./device-stats.ts";
import { watchStream } from "./watch.ts";

/** Options for `pnpm cli voicelab stress`. */
export interface StressOptions extends VoicelabConnectOptions {
  /**
   * Turns to take. The run does not stop before this many are done, even if
   * `--minutes` has already elapsed — a hundred turns is half the point.
   */
  turns?: number;
  /**
   * Minutes to keep going. The run does not stop before this much time has
   * passed, even if `--turns` are done — a leak is a slope, and ninety
   * minutes is the shortest window one shows up in.
   */
  minutes?: number;
  /** Seconds between the starts of two turns, when the answer leaves room. */
  every?: number;
  /** Stream the call rides on. */
  path?: string;
  /** Capability the device mounts itself under (itx.kit.<name>). */
  name?: string;
  /** Write the full timeline here as JSON. */
  out?: string;
  /** Seconds of silence after the speaker goes quiet before the next prompt. */
  settle?: number;
  /** Seconds one answer's playout gets to drain before the turn is a miss. */
  drain?: number;
  /**
   * Seconds of delivered audio the long turns must reach, at the median, for
   * the run to count as having exercised long audio at all.
   */
  longSeconds?: number;
  /** KiB of free memory the run may lose across its length before that is a leak. */
  heapLeakKb?: number;
  /**
   * Percent of delivered audio the device may fail to play before that is a
   * failure. The baseline it is set against: a 26-minute call of short answers
   * lost 3.6%.
   */
  lostPct?: number;
}

/**
 * How much continuous audio a turn is meant to produce.
 *
 * `long` is the reason this command exists: a turn whose answer is minutes of
 * unbroken speech, which is what fills a ring, works the heap, and is heard as
 * a truncated answer when it goes wrong.
 */
type PromptClass = "short" | "medium" | "long";

/** One thing to say to the device, and what kind of answer it is meant to draw. */
interface Prompt {
  promptClass: PromptClass;
  text: string;
  /** True when a correct answer needs something said earlier in this call. */
  referencesEarlier: boolean;
}

/**
 * The shape of every twenty turns: 11 short, 6 medium, 3 long — 55/30/15.
 *
 * Fixed rather than random so two runs are comparable and a failure can be
 * re-provoked. Two long turns are never adjacent (that would test recovery,
 * not endurance), and the first one lands on turn 4, so a run that dies early
 * has still said something about long audio before it did.
 */
const CYCLE: readonly PromptClass[] = [
  "short",
  "medium",
  "short",
  "long",
  "short",
  "medium",
  "short",
  "short",
  "medium",
  "short",
  "long",
  "short",
  "medium",
  "short",
  "short",
  "medium",
  "short",
  "long",
  "short",
  "medium",
];

/**
 * Turn one, always. It plants the three facts the recall prompts below ask
 * for, so "does the conversation still exist?" has an answer that is checkable
 * by a human reading the transcript rather than inferred from a counter.
 */
const OPENING: Prompt = {
  promptClass: "short",
  referencesEarlier: false,
  text:
    "Hello. My name is Jonas, I am in London, and you are speaking through a small " +
    "speaker on my desk. Say hello back in one short sentence.",
};

/** A sentence or two of answer. Four of these can only be answered from memory. */
const SHORT_PROMPTS: readonly Prompt[] = [
  { promptClass: "short", referencesEarlier: false, text: "In one sentence: why is the sky blue?" },
  { promptClass: "short", referencesEarlier: true, text: "What is my name again? Just the name." },
  {
    promptClass: "short",
    referencesEarlier: false,
    text: "Name one bird that cannot fly. One sentence.",
  },
  { promptClass: "short", referencesEarlier: true, text: "Which city did I say I am in?" },
  { promptClass: "short", referencesEarlier: false, text: "In one sentence, what is thunder?" },
  {
    promptClass: "short",
    referencesEarlier: true,
    text: "What are you speaking through? One sentence.",
  },
  { promptClass: "short", referencesEarlier: false, text: "Say something short about the sea." },
  {
    promptClass: "short",
    referencesEarlier: true,
    text: "Earlier I asked you to count out loud. What was the last number you said?",
  },
  {
    promptClass: "short",
    referencesEarlier: false,
    text: "How many legs does a spider have? One sentence.",
  },
  { promptClass: "short", referencesEarlier: false, text: "In one sentence: what is a tide?" },
  {
    promptClass: "short",
    referencesEarlier: false,
    text: "Tell me one short thing about volcanoes.",
  },
  {
    promptClass: "short",
    referencesEarlier: true,
    text: "Have we spoken about anything twice so far? One sentence.",
  },
];

/**
 * A paragraph: tens of seconds of audio, long enough to need a ring.
 *
 * "Yourself" and "of your own" are load-bearing, for the same reason the long
 * prompts spell it out: this agent has a colleague to delegate to, and a
 * delegated question is answered with a two-second acknowledgement.
 */
const MEDIUM_PROMPTS: readonly Prompt[] = [
  {
    promptClass: "medium",
    referencesEarlier: false,
    text: "Answer this yourself, in a full paragraph: why is the sea salty?",
  },
  {
    promptClass: "medium",
    referencesEarlier: false,
    text: "In about five sentences, and in your own words, explain how a microphone works.",
  },
  {
    promptClass: "medium",
    referencesEarlier: false,
    text: "Give me a full paragraph yourself about octopuses — the strangest things about them.",
  },
  {
    promptClass: "medium",
    referencesEarlier: false,
    text: "Tell me yourself, in a paragraph, what happened in the year 1969.",
  },
  {
    promptClass: "medium",
    referencesEarlier: false,
    text: "Describe a rainy afternoon in a harbour town, in a paragraph of your own.",
  },
  {
    promptClass: "medium",
    referencesEarlier: false,
    text: "In about five sentences of your own, explain what an echo is and why it happens.",
  },
  {
    promptClass: "medium",
    referencesEarlier: false,
    text: "Explain yourself, in a paragraph, why bread rises.",
  },
  {
    promptClass: "medium",
    referencesEarlier: false,
    text: "Describe the inside of a lighthouse yourself, in a paragraph.",
  },
];

/**
 * Every long prompt overrides the voice's own brief, out loud, in words.
 *
 * The deployed agent is instructed to "speak plainly and briefly — one or two
 * sentences unless asked for more. Never read out URLs, code, or long lists",
 * and it has a back-office colleague it hands hard questions to. Both are
 * correct for a product and fatal for this test: measured on the first real
 * run, a request for a paragraph came back as "I'll get the back office to
 * explain that properly" — eight seconds of audio where thirty were wanted.
 *
 * So each long prompt says it is a test, claims the exception the brief itself
 * offers, and forbids delegating. If a future brief closes that door the run
 * does not quietly pass on short answers: the verdict fails on the long class
 * not reaching its audio floor, and says so.
 */
const LONG_PROMPTS: readonly Prompt[] = [
  {
    promptClass: "long",
    referencesEarlier: false,
    text:
      "This is a speaker test, so I am asking for more, not less. Count out loud " +
      "from one to one hundred yourself, right now. Say every single number in " +
      "order, skip none, do not summarise, and do not send this to the back " +
      "office. Finish at one hundred.",
  },
  {
    promptClass: "long",
    referencesEarlier: false,
    text:
      "I am asking for a long answer on purpose. Tell me a story of at least four " +
      "hundred words about a lighthouse keeper who befriends a seal. Tell the " +
      "whole thing yourself, out loud, without stopping and without asking anyone.",
  },
  {
    promptClass: "long",
    referencesEarlier: false,
    text:
      "Speaker test, and I do want the long list. Name the countries of Europe one " +
      "at a time and say each capital after it. Say them yourself, out loud, and " +
      "keep going until you have done them all.",
  },
  {
    promptClass: "long",
    referencesEarlier: false,
    text:
      "Another counting test, please. Count backwards out loud from one hundred to " +
      "one, every number, yourself. Do not skip any, do not summarise, and do not " +
      "hand it to the back office.",
  },
  {
    promptClass: "long",
    referencesEarlier: false,
    text:
      "I am asking for more than usual. Explain to me yourself, in at least four " +
      "hundred words, how bread is made — from wheat growing in a field to a " +
      "finished loaf on a table. Keep talking; do not stop early.",
  },
  {
    promptClass: "long",
    referencesEarlier: false,
    text:
      "Long answer wanted. Recite the alphabet slowly yourself, and after each " +
      "letter say a word starting with it and a short sentence using that word. " +
      "Go all the way to Z without stopping.",
  },
];

/**
 * How long each class of answer gets to finish before the turn is a miss.
 *
 * Generous for the long class on purpose: "count to a hundred" is the thing
 * being tested, and a timeout short enough to cut it off would turn the
 * measurement into a report about this harness's patience.
 */
const ANSWER_TIMEOUT_MS: Record<PromptClass, number> = {
  long: 300_000,
  medium: 120_000,
  short: 45_000,
};

/** Every counter this run reads per turn, damage and tolerated alike. */
const WATCHED_COUNTERS = [
  ...MUST_NOT_MOVE,
  ...DAMAGE_MUST_NOT_MOVE,
  ...TOLERATED_COUNTERS,
] as const;

/** Counters whose movement is, by itself, a failed run. */
const FATAL_COUNTERS = [...MUST_NOT_MOVE, ...DAMAGE_MUST_NOT_MOVE] as const;

/** One turn of the conversation, as measured. */
interface StressTurn {
  index: number;
  /** Milliseconds since the run began, when the prompt was appended. */
  atMs: number;
  promptClass: PromptClass;
  prompt: string;
  referencesEarlier: boolean;
  /** Prompt to `response.created` — the provider accepting the turn. */
  thinkingMs?: number;
  /** Prompt to the first speaker frame on the stream. The real first audio. */
  firstAudioMs?: number;
  /** Prompt to the first transcript delta — the model starting to say words. */
  firstTranscriptMs?: number;
  /** Prompt to `response.done` — the answer fully generated, not fully heard. */
  answeredMs?: number;
  /** Prompt to the device's speaker going quiet. The end of the answer. */
  playedOutMs?: number;
  /** Audio the bridge delivered to the stream, in ms of PCM. */
  sentAudioMs?: number;
  /** Audio the device wrote to its DAC, in ms of PCM. What was heard. */
  playedAudioMs?: number;
  sentFrames?: number;
  playedFrames?: number;
  playedBytes?: number;
  /**
   * Frames delivered and never heard: `sentFrames - playedFrames`.
   *
   * The only honest measure of a truncated answer, because there is more than
   * one way to lose a frame and the device counts each separately. Measured on
   * the first real run: a long answer lost 31 of its 74 seconds while
   * `spkDiscarded` never moved — those frames went to `spkOverflow`, a
   * different counter. A loss metric named after one cause reports zero while
   * the listener hears half an answer.
   */
  lostFrames?: number;
  /** Frames the device explicitly discarded — one cause among several. */
  discardedFrames?: number;
  /** Every watched device counter that moved during this turn. */
  counters?: Record<string, number>;
  /** Free internal heap at the end of the turn, in bytes. */
  heapFree?: number;
  /** Free PSRAM at the end of the turn, in bytes; absent when unpublished. */
  psramFree?: number;
  /** Deepest the playout ring had ever been, at the end of this turn. */
  ringMarginMaxMs?: number;
  transcript?: string;
  /** Why this turn did not count, when it did not. */
  miss?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The prompt for turn `index` (1-based), from the fixed cycle above. */
function promptFor(index: number, taken: Record<PromptClass, number>): Prompt {
  if (index === 1) return OPENING;
  const promptClass = CYCLE[(index - 1) % CYCLE.length]!;
  const pool =
    promptClass === "long"
      ? LONG_PROMPTS
      : promptClass === "medium"
        ? MEDIUM_PROMPTS
        : SHORT_PROMPTS;
  const prompt = pool[taken[promptClass] % pool.length]!;
  taken[promptClass]++;
  return prompt;
}

/** The device's control surface, as this command uses it. */
interface DeviceCapability {
  conversation: { start(): Promise<boolean>; hangUp(): Promise<boolean> };
  health(): Promise<Record<string, unknown>>;
}

/** One dev-stats sample plus when this process saw it. */
interface StatsSample extends DeviceStats {
  /** Milliseconds since the run began, on this machine's clock. */
  atMs: number;
}

export async function stress(options: StressOptions) {
  const targetTurns = options.turns ?? 120;
  const minutes = options.minutes ?? 90;
  const everyMs = (options.every ?? 45) * 1000;
  const settleMs = (options.settle ?? 6) * 1000;
  const drainMs = (options.drain ?? 300) * 1000;
  const longSecondsFloor = options.longSeconds ?? 45;
  const heapLeakKb = options.heapLeakKb ?? 256;
  const lostPctLimit = options.lostPct ?? 10;
  const streamPath = options.path ?? "/agents/voice/device";
  const capabilityName = options.name ?? "waveshare";

  using itx = await connectProject(options);
  const kit = (itx as unknown as { kit: Record<string, DeviceCapability> }).kit;
  const capability = kit[capabilityName];
  if (!capability) throw new Error(`no device capability named ${capabilityName}`);
  const stream = itx.streams.get(streamPath);

  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;
  const samples: StatsSample[] = [];
  const turns: StressTurn[] = [];
  const events: { atMs: number; what: string }[] = [];
  const note = (what: string) => {
    events.push({ atMs: elapsed(), what });
    console.error(`[${(elapsed() / 60_000).toFixed(1)}m] ${what}`);
  };

  /*
   * THE ANSWER IN FLIGHT. Filled by the watcher's callback, read by the turn
   * loop. There is only ever one, because the bridge cancels a response the
   * moment a new turn arrives and this run never sends one until the previous
   * answer has been heard all the way out.
   */
  let answer: {
    createdAt: number;
    firstTranscriptAt: number;
    doneAt: number;
    text: string;
  } | null = null;
  /** When the bridge last said it had this call. Zero means it does not. */
  let callLiveAt = 0;
  let callAccepts = 0;
  let callRestarts = 0;
  let redials = 0;
  let providerErrors = 0;
  /**
   * True once the conversation under test is up.
   *
   * Before that the harness has deliberately hung up any call it found, and
   * the device duly reports `call-ended: button` for it — counting that would
   * put "the call ended" in the report of every healthy run.
   */
  let runLive = false;
  const callEnds: { atMs: number; reason: string; afterTurn: number }[] = [];

  /*
   * The watcher is opened FIRST, before the call, before anything is asked.
   * dev-stats and audio frames are ephemeral: they only reach connections
   * that already existed when they were appended, so an instrument opened
   * later measures a suspiciously healthy device.
   *
   * Speaker frames are NOT subscribed here. They are the bulk of the traffic
   * and every one delivered spends this connection's push budget — over 90
   * minutes of long answers that is millions of frames through an instrument
   * that plays none of them. First-audio timing gets its own connection,
   * opened per turn and closed on the first frame.
   */
  const watch = await watchStream({
    eventTypes: [
      "voicelab/dev-stats",
      "voicelab/grok-event",
      "voicelab/call-accepted",
      "voicelab/call-ended",
      "voicelab/bridge-redialling",
    ],
    key: `stress-${startedAt}`,
    onNote: note,
    stream,
    /*
     * dev-stats is published from inside the device's "everything ready" gate
     * and only when its outbox has room, so a device that is wedged but still
     * answering calls goes dark on this stream while being perfectly reachable.
     * `health()` is the same JSON by another door, and it is the only thing
     * that can tell "gone" from "stuck" at the moment it matters.
     */
    onDeviceQuiet: () => {
      void capability
        .health()
        .then((health) => {
          note(
            `the device still answers: transport=${String(health.transport)} ` +
              `voicelab=${String(health.voicelab)} failure=${String(health.voicelabFailure)} ` +
              `gateOpen=${String(health.gateOpen)} callActive=${String(health.callActive)} ` +
              `outboxUsed=${String(health.outboxUsed)}/${String(health.outboxSlots)} ` +
              `uptimeMs=${String(health.uptimeMs)}`,
          );
        })
        .catch((error: unknown) => {
          note(`the device does not answer health either: ${String(error)}`);
        });
    },
    onBatch: (batch) => {
      for (const event of batch.events) {
        const payload = (event.payload ?? {}) as Record<string, unknown>;
        if (event.type === "voicelab/dev-stats") {
          samples.push({ ...(payload as DeviceStats), atMs: elapsed() });
          continue;
        }
        if (event.type === "voicelab/call-accepted") {
          callLiveAt = Date.now();
          callAccepts++;
          note(`call-accepted by bridge ${String(payload.bridgeId ?? payload.bridge ?? "?")}`);
          continue;
        }
        if (event.type === "voicelab/call-ended") {
          callLiveAt = 0;
          if (runLive) {
            callEnds.push({
              afterTurn: turns.length,
              atMs: elapsed(),
              reason: String(payload.reason ?? "unknown"),
            });
          }
          note(`CALL ENDED: ${String(payload.reason)}`);
          continue;
        }
        if (event.type === "voicelab/bridge-redialling") {
          /* Not a failure: the provider closes its socket on its own schedule
           * and the bridge replaces it under the conversation, replaying what
           * was said. Counted, because one per turn would mean something else. */
          redials++;
          note(`bridge redialling (${String(payload.reason)})`);
          continue;
        }
        const inner = (payload as { event?: { type?: string; delta?: string } }).event;
        if (!inner) continue;
        if (inner.type === "error") {
          providerErrors++;
          note(`provider error around turn ${turns.length + 1}`);
          continue;
        }
        if (!answer) continue;
        if (inner.type === "response.created" && answer.createdAt === 0) {
          answer.createdAt = Date.now();
        }
        if (inner.type === "response.output_audio_transcript.delta") {
          if (answer.firstTranscriptAt === 0) answer.firstTranscriptAt = Date.now();
          answer.text += inner.delta ?? "";
        }
        if (inner.type === "response.done" && answer.doneAt === 0) answer.doneAt = Date.now();
      }
    },
  });

  /**
   * One connection whose only job is to timestamp the FIRST speaker frame of
   * one answer, then get out of the way.
   *
   * Nothing else on the stream can say when audio actually started: the
   * transcript delta says the model began talking, and the device's counters
   * arrive 5s apart. This is opened before the prompt (ephemeral events reach
   * no one else) and closed the instant it has its answer, so it costs a
   * handful of pushes rather than a whole answer's worth.
   */
  const openAudioProbe = async (index: number) => {
    let firstAt = 0;
    const handle = await stream.openConnection({
      connectionKey: `stress-audio-${startedAt}-${index}`,
      eventTypes: ["voicelab/spk-frame"],
      maxDeliveryBytes: 1400,
      maxDeliveryEvents: 1,
      processEventBatch: (batch) => {
        if (firstAt === 0 && batch.events.length > 0) firstAt = Date.now();
      },
      state: false,
    });
    return { at: () => firstAt, close: () => handle.close() };
  };

  /**
   * Press the call button until the call is up and has STAYED up — see
   * `call.ts` for the measured reason a single press is not enough.
   */
  const pressUntilLive = async (deadline: number) =>
    await bringCallUp({
      deadline,
      liveSince: () => callLiveAt,
      note,
      press: () => capability.conversation.start(),
    });

  /** Bring the call back if it went away, and say whether there is one. */
  const ensureCallLive = async () => {
    if (callLiveAt > 0) return true;
    note("no live call — waiting for the device to redial on its own");
    const waitUntil = Date.now() + 90_000;
    while (Date.now() < waitUntil && callLiveAt === 0) await sleep(1000);
    if (callLiveAt > 0) return true;
    callRestarts++;
    note("device did not redial — asking it to call again");
    return await pressUntilLive(Date.now() + 90_000);
  };

  note(
    `stress begins on ${streamPath}: at least ${targetTurns} turns AND at least ` +
      `${minutes} minutes, a turn every ${everyMs / 1000}s or as soon after as the ` +
      `speaker goes quiet. Every 20 turns: 11 short, 6 medium, 3 long.`,
  );

  /* Start from a known state: whatever call was on this stream belonged to
   * somebody else's run and may be bound to a bridge that is already gone. */
  await capability.conversation.hangUp().catch(() => {});
  await sleep(5000);
  if (!(await pressUntilLive(Date.now() + 150_000))) {
    watch.close();
    throw new Error("the call never went live; nothing to stress");
  }
  note("call is live");
  runLive = true;
  /* The generation the whole run is asserted against: one session, start to
   * finish. Read after the call is up so a boot-time sample cannot set it. */
  const openingSession = samples[samples.length - 1]?.sessionGeneration;
  /* Where the conversation under test starts in the sample series. Samples
   * before it belong to a device that was booting, or idle, or on somebody
   * else's call, and its gate was legitimately shut in all three. */
  const liveSampleIndex = samples.length;
  /*
   * The sample the WHOLE RUN is measured from: the same one turn 1 measured
   * itself from, which is the last one before its prompt.
   *
   * Not `liveSampleIndex`. Measured: the call came up at 12s, two samples had
   * landed, and the third — the first one at or after `liveSampleIndex` — had
   * already absorbed turn 1's audio. Comparing that against the end reported
   * `spkCatchup` moving by 1 when the device had counted 170. Every per-turn
   * delta was right and the total was wrong, which is the worst way for a
   * number to be wrong: the verdict reads the total.
   */
  let runBaselineIndex = -1;

  const taken: Record<PromptClass, number> = { long: 0, medium: 0, short: 0 };
  /** Set when the run stopped for a reason other than reaching its targets. */
  let endedEarly: string | null = null;
  /*
   * A guard, not a target: every wait in a turn is bounded, but 120 turns of a
   * device answering at its slowest would run all night. Twice the requested
   * minutes, and never less than half an hour so a four-turn smoke with
   * `--minutes 0` is not killed before it starts.
   */
  const ceilingAt = startedAt + Math.max(minutes * 2, 30) * 60_000;

  while (turns.length < targetTurns || elapsed() < minutes * 60_000) {
    if (Date.now() > ceilingAt) {
      endedEarly = `hard ceiling: ${(elapsed() / 60_000).toFixed(0)} minutes for ${turns.length} turns`;
      note(endedEarly);
      break;
    }
    if (!(await ensureCallLive())) {
      endedEarly = `the call did not come back after ${turns.length} turns`;
      note(endedEarly);
      break;
    }

    const index = turns.length + 1;
    const prompt = promptFor(index, taken);
    const beforeIndex = samples.length - 1;
    if (runBaselineIndex < 0) runBaselineIndex = Math.max(0, beforeIndex);
    /* A turn the call dies during measures the teardown, not the device: the
     * queued audio is dropped on purpose, and reporting that as a 60% loss
     * blames the device for doing as it was told. Measured on the first real
     * run of this command, when the call button was pressed mid-answer. */
    const callEndsBefore = callEnds.length;
    const probe = await openAudioProbe(index);
    const turnAt = Date.now();
    answer = { createdAt: 0, doneAt: 0, firstTranscriptAt: 0, text: "" };
    await stream.append({ payload: { text: prompt.text }, type: "voicelab/say" });

    const timeoutMs = ANSWER_TIMEOUT_MS[prompt.promptClass];
    const answerDeadline = turnAt + timeoutMs;
    let firstAudioMs: number | undefined;
    while (Date.now() < answerDeadline) {
      if (firstAudioMs === undefined && probe.at() > 0) {
        firstAudioMs = probe.at() - turnAt;
        probe.close();
      }
      if (answer.doneAt > 0) break;
      await sleep(100);
    }
    if (firstAudioMs === undefined && probe.at() > 0) firstAudioMs = probe.at() - turnAt;
    probe.close();

    const finished = answer.doneAt > 0;
    const record: StressTurn = {
      atMs: turnAt - startedAt,
      firstAudioMs,
      firstTranscriptMs:
        answer.firstTranscriptAt > 0 ? answer.firstTranscriptAt - turnAt : undefined,
      index,
      prompt: prompt.text,
      promptClass: prompt.promptClass,
      referencesEarlier: prompt.referencesEarlier,
      thinkingMs: answer.createdAt > 0 ? answer.createdAt - turnAt : undefined,
      transcript: answer.text.slice(0, 400),
      ...(finished ? { answeredMs: answer.doneAt - turnAt } : {}),
    };

    const playout = await waitForQuietPlayout({
      baselinePlayed: Number(samples[samples.length - 1]?.spkPlayed ?? 0),
      samples,
      timeoutMs: drainMs,
    });
    record.playedOutMs = elapsed() - record.atMs;
    /* Re-read the transcript: deltas can still be arriving as the answer's
     * audio drains, and a truncated transcript reads as a truncated answer. */
    record.transcript = answer.text.slice(0, 400);
    answer = null;

    const before = beforeIndex >= 0 ? samples[beforeIndex] : undefined;
    const after = samples[samples.length - 1];
    if (before && after && after !== before) {
      record.sentFrames = counterDelta(before, after, "spkFrames");
      record.playedFrames = counterDelta(before, after, "spkPlayed");
      record.discardedFrames = counterDelta(before, after, "spkDiscarded");
      record.lostFrames = Math.max(0, record.sentFrames - record.playedFrames);
      record.sentAudioMs = record.sentFrames * FRAME_MS;
      record.playedAudioMs = record.playedFrames * FRAME_MS;
      record.playedBytes = record.playedFrames * FRAME_BYTES;
      record.counters = movedCounters(before, after, WATCHED_COUNTERS);
      record.heapFree = typeof after.heapFree === "number" ? after.heapFree : undefined;
      record.psramFree = typeof after.psramFree === "number" ? after.psramFree : undefined;
      record.ringMarginMaxMs =
        typeof after.spkMarginMaxMs === "number" ? after.spkMarginMaxMs : undefined;
    }

    if (callEnds.length > callEndsBefore) {
      record.miss = `the call ended during this turn (${callEnds[callEndsBefore]?.reason ?? "unknown"})`;
    } else if (!finished) record.miss = `no response.done within ${timeoutMs / 1000}s`;
    else if (record.playedFrames === undefined) record.miss = "the device published no dev-stats";
    else if (playout === "never started") {
      record.miss = `the model answered and the speaker never started${
        (record.counters?.spkIgnoredDup ?? 0) > 0
          ? ` — the playout refused ${record.counters?.spkIgnoredDup} frames as duplicates`
          : ""
      }`;
    } else if (playout === "still playing") {
      record.miss = `the speaker never went quiet within ${drainMs / 1000}s`;
    } else if (record.playedFrames <= 0) {
      record.miss = "the model answered but nothing was played";
    }
    turns.push(record);

    const fatalHere = Object.entries(record.counters ?? {}).filter(([key]) =>
      (FATAL_COUNTERS as readonly string[]).includes(key),
    );
    const seconds = (ms: number | undefined) =>
      ms === undefined ? "  --  " : `${(ms / 1000).toFixed(1)}s`;
    const lost =
      record.sentFrames && record.sentFrames > 0
        ? `${(((record.lostFrames ?? 0) / record.sentFrames) * 100).toFixed(1)}%`
        : "--";
    console.error(
      `[${(elapsed() / 60_000).toFixed(1)}m] turn ${String(index).padStart(3)} ` +
        `${prompt.promptClass.padEnd(6)} audio@${seconds(record.firstAudioMs)} ` +
        `done@${seconds(record.answeredMs)} played ${seconds(record.playedAudioMs)}` +
        ` of ${seconds(record.sentAudioMs)} sent (lost ${lost}) ` +
        `heap ${Math.round((record.heapFree ?? 0) / 1024)}k ` +
        `psram ${Math.round((record.psramFree ?? 0) / 1024)}k` +
        (record.miss ? `  MISS: ${record.miss}` : "") +
        (fatalHere.length > 0
          ? `  !! ${fatalHere.map(([key, value]) => `${key} +${value}`).join(" ")}`
          : ""),
    );
    if (record.transcript) {
      console.error(`             "${record.transcript.slice(0, 100).replaceAll("\n", " ")}"`);
    }

    const nextAt = Math.max(turnAt + everyMs, Date.now() + settleMs);
    const wait = nextAt - Date.now();
    if (wait > 0) await sleep(wait);
  }

  watch.close();
  await capability.conversation.hangUp().catch(() => {});

  /* ---- What happened, and whether it counts. ---------------------------- */

  /*
   * Only the samples that belong to THIS conversation. A device that booted a
   * minute ago has a settling heap and a shut gate, and charging either to the
   * run would be reporting the boot as a defect. Falls back to everything when
   * the call came up before the first sample landed.
   */
  const live = samples.slice(runBaselineIndex >= 0 ? runBaselineIndex : liveSampleIndex);
  const measured = live.length > 0 ? live : samples;
  const first = measured[0];
  const last = measured[measured.length - 1];
  const fatalMoved = movedCounters(first, last, FATAL_COUNTERS);
  const toleratedMoved = movedCounters(first, last, TOLERATED_COUNTERS);
  /** Where each fatal counter first moved — a turn number is actionable, a total is not. */
  const fatalFirstSeen: Record<string, { turn: number; promptClass: PromptClass }> = {};
  for (const key of Object.keys(fatalMoved)) {
    const turn = turns.find((candidate) => (candidate.counters?.[key] ?? 0) !== 0);
    if (turn) fatalFirstSeen[key] = { promptClass: turn.promptClass, turn: turn.index };
  }

  const byClass = (["short", "medium", "long"] as const).map((promptClass) => {
    const mine = turns.filter((turn) => turn.promptClass === promptClass);
    const good = mine.filter((turn) => turn.miss === undefined);
    const sentFrames = good.reduce((total, turn) => total + (turn.sentFrames ?? 0), 0);
    const lostFrames = good.reduce((total, turn) => total + (turn.lostFrames ?? 0), 0);
    const toleratedTotals: Record<string, number> = {};
    for (const key of TOLERATED_COUNTERS) {
      const total = mine.reduce((sum, turn) => sum + (turn.counters?.[key] ?? 0), 0);
      if (total !== 0) toleratedTotals[key] = total;
    }
    return {
      promptClass,
      turns: mine.length,
      misses: mine.filter((turn) => turn.miss !== undefined).map((turn) => turn.index),
      answeredMs: spread(
        good.flatMap((turn) => (turn.answeredMs === undefined ? [] : [turn.answeredMs])),
      ),
      firstAudioMs: spread(
        good.flatMap((turn) => (turn.firstAudioMs === undefined ? [] : [turn.firstAudioMs])),
      ),
      sentAudioSeconds: spread(
        good.flatMap((turn) => (turn.sentAudioMs === undefined ? [] : [turn.sentAudioMs / 1000])),
      ),
      playedAudioSeconds: spread(
        good.flatMap((turn) =>
          turn.playedAudioMs === undefined ? [] : [turn.playedAudioMs / 1000],
        ),
      ),
      lostPct: sentFrames === 0 ? null : Number(((lostFrames / sentFrames) * 100).toFixed(2)),
      toleratedTotals,
    };
  });
  const longClass = byClass.find((entry) => entry.promptClass === "long")!;

  const heapSeries = measured.flatMap((sample) =>
    typeof sample.heapFree === "number" ? [sample.heapFree] : [],
  );
  const psramSeries = measured.flatMap((sample) =>
    typeof sample.psramFree === "number" ? [sample.psramFree] : [],
  );
  const samplesPerMinute =
    measured.length > 1 && last && first
      ? 60_000 / ((last.atMs - first.atMs) / (measured.length - 1))
      : 0;
  /**
   * A leak is the difference between the START of the run and the END of it,
   * taken as medians over the first and last tenth so one unlucky sample
   * cannot invent or hide one. The slope is reported beside it because a
   * flat-but-noisy series and a steadily falling one look identical from two
   * endpoints.
   */
  const trend = (series: readonly number[]) => {
    if (series.length === 0) return null;
    const window = Math.max(3, Math.floor(series.length / 10));
    const median = (values: readonly number[]) =>
      [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)]!;
    const early = median(series.slice(0, window));
    const late = median(series.slice(-window));
    return {
      firstBytes: series[0]!,
      lastBytes: series[series.length - 1]!,
      minBytes: Math.min(...series),
      maxBytes: Math.max(...series),
      earlyMedianBytes: early,
      lateMedianBytes: late,
      lostKb: Number(((early - late) / 1024).toFixed(1)),
      slopeBytesPerMinute: Math.round(slopePerStep(series) * samplesPerMinute),
    };
  };
  const heap = trend(heapSeries);
  const psram = trend(psramSeries);

  /*
   * Totals over the turns that COUNT. A turn the call died during delivered
   * audio nobody was ever going to hear, and averaging it in would blame the
   * device for somebody pressing hang up.
   */
  const counted = turns.filter((turn) => turn.miss === undefined);
  const sentFramesTotal = counted.reduce((total, turn) => total + (turn.sentFrames ?? 0), 0);
  const lostFramesTotal = counted.reduce((total, turn) => total + (turn.lostFrames ?? 0), 0);
  const discardedTotal = counted.reduce((total, turn) => total + (turn.discardedFrames ?? 0), 0);
  const lostPct = sentFramesTotal === 0 ? 0 : (lostFramesTotal / sentFramesTotal) * 100;
  const misses = turns.filter((turn) => turn.miss !== undefined);
  /* Over the measured window only: a device that re-mounted while booting, one
   * sample before the conversation started, did not change session DURING it. */
  const sessionGenerations = [
    ...new Set(
      measured.flatMap((sample) =>
        sample.sessionGeneration === undefined ? [] : [sample.sessionGeneration],
      ),
    ),
  ];
  const reboots = measured.filter(
    (sample, at) =>
      at > 0 && Number(sample.uptimeMs ?? 0) < Number(measured[at - 1]!.uptimeMs ?? 0),
  ).length;
  const stateFaults = measured
    .filter(
      (sample) =>
        (sample.voicelabFailure !== undefined && sample.voicelabFailure !== "none") ||
        sample.gateOpen === false,
    )
    .map((sample) => ({
      atMs: sample.atMs,
      gateOpen: sample.gateOpen,
      voicelabFailure: sample.voicelabFailure,
    }));

  const failures: string[] = [];
  /* Named individually up to a point, because which turn and which class is
   * the whole diagnosis; past that a hundred lines of it is not a verdict. The
   * per-turn timeline in `--out` has every one. */
  for (const miss of misses.slice(0, 10)) {
    failures.push(`turn ${miss.index} (${miss.promptClass}): ${miss.miss}`);
  }
  if (misses.length > 10) {
    failures.push(`…and ${misses.length - 10} more turn(s) that did not count`);
  }
  for (const [key, delta] of Object.entries(fatalMoved)) {
    const where = fatalFirstSeen[key];
    failures.push(
      `${key} moved by ${delta}${where ? ` (first on turn ${where.turn}, ${where.promptClass})` : ""}`,
    );
  }
  if (sessionGenerations.length > 1) {
    failures.push(
      `the device's session generation changed: ${sessionGenerations.join(" → ")} ` +
        `(opened at ${String(openingSession)}) — this was not one session`,
    );
  }
  if (reboots > 0) failures.push(`the device rebooted ${reboots} time(s) mid-conversation`);
  if (stateFaults.length > 0) {
    failures.push(
      `the device reported a fault or a shut gate ${stateFaults.length} time(s): ` +
        JSON.stringify(stateFaults[0]),
    );
  }
  if (longClass.turns === 0) {
    failures.push(
      "no long turn ran at all — a run of short turns is not a pass, it is the test " +
        "this command exists to replace",
    );
  } else if ((longClass.sentAudioSeconds.median ?? 0) < longSecondsFloor) {
    failures.push(
      `the long turns did not produce sustained audio: median ${String(longClass.sentAudioSeconds.median)}s ` +
        `delivered, floor is ${longSecondsFloor}s — long audio was never actually exercised`,
    );
  }
  if (heap && heap.lostKb > heapLeakKb) {
    failures.push(
      `free heap fell ${heap.lostKb}KiB over the run (limit ${heapLeakKb}KiB, ` +
        `slope ${heap.slopeBytesPerMinute} B/min) — that is a leak, not noise`,
    );
  }
  if (psram && psram.lostKb > heapLeakKb) {
    failures.push(
      `free PSRAM fell ${psram.lostKb}KiB over the run (limit ${heapLeakKb}KiB, ` +
        `slope ${psram.slopeBytesPerMinute} B/min)`,
    );
  }
  if (lostPct > lostPctLimit) {
    failures.push(
      `the device never played ${lostPct.toFixed(1)}% of the audio delivered to it ` +
        `(limit ${lostPctLimit}%) — answers were truncated. Where the frames went: ` +
        JSON.stringify({ ...fatalMoved, ...toleratedMoved }),
    );
  }
  if (samples.length === 0) {
    failures.push("the device published no dev-stats at all — nothing here was measured");
  }

  /* Facts that are not failures but change how the numbers should be read. */
  const notes: string[] = [];
  if (endedEarly) notes.push(endedEarly);
  for (const end of callEnds) {
    notes.push(
      end.reason === "max call duration"
        ? `the bridge ended the call at ${(end.atMs / 60_000).toFixed(0)} minutes on its own ` +
            `65-minute backstop (after turn ${end.afterTurn}); turns past that point are a ` +
            `SECOND call with no memory of the first`
        : `the call ended after turn ${end.afterTurn}: ${end.reason}`,
    );
  }
  if (redials > 0) notes.push(`the bridge replaced its provider socket ${redials} time(s)`);
  if (callRestarts > 0)
    notes.push(`this harness had to ask for the call again ${callRestarts} time(s)`);
  if (watch.reopens > 0)
    notes.push(`the watching connection was replaced ${watch.reopens} time(s)`);
  if (watch.deviceQuiet > 0) {
    notes.push(
      `the device stopped publishing while its connection was alive ${watch.deviceQuiet} time(s)`,
    );
  }
  if (providerErrors > 0) notes.push(`the provider reported ${providerErrors} error event(s)`);
  if (Object.keys(toleratedMoved).length > 0) {
    notes.push(`counters a healthy call also moves: ${JSON.stringify(toleratedMoved)}`);
  }

  const answered = turns.filter((turn) => turn.miss === undefined);
  const summary = {
    verdict: failures.length === 0 ? ("PASS" as const) : ("FAIL" as const),
    failures,
    notes,
    turns: turns.length,
    answered: answered.length,
    minutes: Number((elapsed() / 60_000).toFixed(1)),
    byClass,
    audio: {
      sentSeconds: Number(((sentFramesTotal * FRAME_MS) / 1000).toFixed(1)),
      playedSeconds: Number(
        (
          (counted.reduce((total, turn) => total + (turn.playedFrames ?? 0), 0) * FRAME_MS) /
          1000
        ).toFixed(1),
      ),
      lostSeconds: Number(((lostFramesTotal * FRAME_MS) / 1000).toFixed(1)),
      discardedSeconds: Number(((discardedTotal * FRAME_MS) / 1000).toFixed(1)),
      lostPct: Number(lostPct.toFixed(2)),
    },
    latencyMs: {
      firstAudio: spread(
        answered.flatMap((turn) => (turn.firstAudioMs === undefined ? [] : [turn.firstAudioMs])),
      ),
      answered: spread(
        answered.flatMap((turn) => (turn.answeredMs === undefined ? [] : [turn.answeredMs])),
      ),
    },
    heap,
    psram,
    heapMinEverBytes: typeof last?.heapMin === "number" ? last.heapMin : null,
    session: {
      openingSession: openingSession ?? null,
      sessionGenerations,
      connGenerations: [
        ...new Set(
          measured.flatMap((sample) =>
            sample.connGeneration === undefined ? [] : [sample.connGeneration],
          ),
        ),
      ].length,
      reboots,
      callAccepts,
      callEnds,
      callRestarts,
      bridgeRedials: redials,
      watchReopens: watch.reopens,
      deviceQuietPeriods: watch.deviceQuiet,
    },
    gauges: {
      ringMarginMaxMs: typeof last?.spkMarginMaxMs === "number" ? last.spkMarginMaxMs : null,
      ringLagMaxMs: typeof last?.spkLagMaxMs === "number" ? last.spkLagMaxMs : null,
      inboxHighWater: typeof last?.inboxHighWater === "number" ? last.inboxHighWater : null,
    },
    countersMoved: { fatal: fatalMoved, fatalFirstSeen, tolerated: toleratedMoved },
    statsSamples: samples.length,
  };

  console.log(JSON.stringify(summary, null, 2));
  if (options.out) {
    fs.writeFileSync(options.out, JSON.stringify({ events, samples, summary, turns }, null, 2));
    console.error(`timeline: ${options.out}`);
  }
  if (summary.verdict === "FAIL") process.exitCode = 1;
}
