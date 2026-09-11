// One open-mic call driven from the wire, shared by the probes that need
// one: `duplex` (the platform proof) and `ask` (the task battery).
//
// EXTRACTED, NOT DESIGNED. The realtime-paced microphone loop and the
// listener that reads speaker frames and mirrored provider events back were
// the same ~120 lines in two files; a helper module, deliberately NOT
// exported from ./index.ts — cli.ts turns index.ts exports into commands, and
// this is an instrument, not a command.
//
// THE DRIVER IS THE DUMBEST POSSIBLE CLIENT: it appends 20 ms microphone
// frames at realtime pace for the whole call (silence when it has nothing to
// say — what an open microphone in a quiet room IS), and splices utterances
// in without breaking the cadence. Everything it knows about the call it read
// off the stream.
import { type VoicelabConnectOptions } from "./connect.ts";
import { deliveredMsOf, FRAME_BYTES, FRAME_MS, openStream, sleep } from "./probe-audio.ts";

/** What an open microphone in a quiet room is: 20 ms of silence, forever. */
const SILENCE_FRAME = Buffer.alloc(FRAME_BYTES).toString("base64");

/** One delegation the voice raised, as the mirror showed it. */
export interface WireDelegation {
  id: string;
  target: string;
  /** Call clock. */
  createdAtMs: number;
  /** Call clock when the backend's final `message` item completed — the end
   * of this delegation's work; null while it is still working. */
  finalTextDoneAtMs: number | null;
  /** The backend's final text, as streamed. */
  finalText: string;
  functionCalls: number;
  /** The user transcript that had arrived when the delegation was raised —
   * how much of the request the backend could have been given. */
  inputTranscriptAtCreation: string;
}

/** Everything the listener collected off the wire, updated live. */
export interface WireWatch {
  spkFrames: number;
  answersEnded: number;
  answerDeliveredMs: number;
  lastAudioFrameAtMs: number | null;
  clearsSeen: number;
  delegations: WireDelegation[];
  /** `→ name(args)` for each backend function call, `← {output}` for each answer. */
  backendCalls: string[];
  backendFunctionCalls: number;
  inputTranscript: string;
  outputTranscript: string;
  /** Call clock of every assistant transcript fragment, in arrival order. */
  assistantFragmentArrivals: number[];
  /** Call clock of every user transcript fragment, in arrival order. */
  userFragmentArrivals: number[];
  /** Raw provider events by type, for anything a probe wants to count. */
  providerEventCounts: Record<string, number>;
}

export interface WireCall {
  readonly streamPath: string;
  readonly watch: WireWatch;
  /** Milliseconds since the call opened. */
  clock(): number;
  /** Splice an utterance into the microphone stream; resolves when its last frame went out. */
  speak(frames: string[]): Promise<void>;
  micFramesSent(): number;
  /** Poll `predicate` every 100 ms until true or `timeoutMs`; returns its final value. */
  waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean>;
  /** True once no audible speaker frame has arrived for `quietMs`. */
  quietFor(quietMs: number): boolean;
  /** Stop the microphone and close the live connection. */
  stop(): Promise<void>;
  /** The durable voice events since the call opened, read back from the stream. */
  durableEvents(): Promise<{ type: string; createdAt: string; payload?: unknown }[]>;
}

/** The stream handle's read surface the verdicts need. */
interface VoiceStreamReads {
  getEvents(input: {
    afterOffset: number;
    eventTypes?: string[];
    limit: number;
  }): Promise<{ type: string; createdAt: string; payload?: unknown }[]>;
}

export async function openWireCall(
  options: VoicelabConnectOptions & { streamPath: string },
): Promise<WireCall> {
  const stream = await openStream(options);
  const startedAtMs = Date.now();
  const clock = () => Date.now() - startedAtMs;
  const watch: WireWatch = {
    spkFrames: 0,
    answersEnded: 0,
    answerDeliveredMs: 0,
    lastAudioFrameAtMs: null,
    clearsSeen: 0,
    delegations: [],
    backendCalls: [],
    backendFunctionCalls: 0,
    inputTranscript: "",
    outputTranscript: "",
    assistantFragmentArrivals: [],
    userFragmentArrivals: [],
    providerEventCounts: {},
  };

  const connection = await stream.openConnection({
    connectionKey: `wire-call-${Date.now()}`,
    eventTypes: [
      "events.iterate.com/voice-agent/spk-frame",
      "events.iterate.com/voice-agent/grok-event",
    ],
    processEventBatch: (batch: { events?: { type: string; payload?: unknown }[] }) => {
      for (const event of batch.events ?? []) {
        /* Stream payloads arrive as untyped JSON; the assertion only names
         * the record shape, and every field read below is checked by type. */
        const payload = (event.payload ?? {}) as Record<string, unknown>;
        if (event.type === "events.iterate.com/voice-agent/spk-frame") {
          watch.spkFrames += 1;
          const pcm = typeof payload.pcm === "string" ? payload.pcm : "";
          if (payload.clearSpeakerBufferBeforeFrame === true && pcm === "") watch.clearsSeen += 1;
          if (payload.lastFrameOfAnswer === true) watch.answersEnded += 1;
          if (pcm !== "") {
            watch.answerDeliveredMs += deliveredMsOf(pcm);
            watch.lastAudioFrameAtMs = clock();
          }
          continue;
        }
        const type = String(payload.type ?? "");
        watch.providerEventCounts[type] = (watch.providerEventCounts[type] ?? 0) + 1;
        if (type === "session.delegation.created") {
          /* The provider's delegation object, per its schema; a differently
           * shaped one reads as an unknown target. */
          const info = payload.delegation as { id?: string; target?: string } | undefined;
          watch.delegations.push({
            id: String(info?.id ?? ""),
            target: String(info?.target ?? ""),
            createdAtMs: clock(),
            finalTextDoneAtMs: null,
            finalText: "",
            functionCalls: 0,
            inputTranscriptAtCreation: watch.inputTranscript,
          });
        }
        if (type === "response.event") {
          /* The nested Responses event, per the provider's schema; the
           * optional fields are all this instrument reads, each guarded. */
          const inner = (payload.event ?? {}) as {
            type?: string;
            delta?: string;
            item?: { type?: string; name?: string; arguments?: string };
          };
          const delegation = watch.delegations.find((d) => d.id === payload.delegation_id);
          if (inner.type === "response.output_text.delta" && delegation !== undefined) {
            delegation.finalText += String(inner.delta ?? "");
          }
          if (inner.type === "response.output_item.done" && inner.item?.type === "function_call") {
            watch.backendFunctionCalls += 1;
            if (delegation !== undefined) delegation.functionCalls += 1;
            watch.backendCalls.push(
              `→ ${String(inner.item.name)}(${String(inner.item.arguments ?? "").slice(0, 240)})`,
            );
          }
          if (
            inner.type === "response.output_item.done" &&
            inner.item?.type === "message" &&
            delegation !== undefined
          ) {
            delegation.finalTextDoneAtMs = clock();
          }
        }
        if (type === "client.response.item.create") {
          watch.backendCalls.push(`← ${String(payload.itemSummary ?? "").slice(0, 300)}`);
        }
        if (type === "session.output_transcript.delta") {
          watch.outputTranscript += String(payload.delta ?? "");
          watch.assistantFragmentArrivals.push(clock());
        }
        if (type === "session.input_transcript.delta") {
          watch.inputTranscript += String(payload.delta ?? "");
          watch.userFragmentArrivals.push(clock());
        }
      }
    },
  });

  /* THE MICROPHONE NEVER STOPS: one loop, 25 frames per half second. */
  let pending: string[] = [];
  let micFramesSent = 0;
  let stopMic = false;
  const micLoop = (async () => {
    const startedAt = Date.now();
    let sequence = 0;
    while (!stopMic) {
      const due = startedAt + (sequence + 25) * FRAME_MS;
      const wait = due - Date.now();
      if (wait > 0) await sleep(wait);
      const events = [];
      for (let index = 0; index < 25; index++) {
        /* The empty string is speak()'s end marker, never audio: it leaves
         * the queue here and silence goes out in its place. */
        const next = pending.shift();
        const pcm = next === undefined || next === "" ? SILENCE_FRAME : next;
        events.push({
          type: "events.iterate.com/voice-agent/mic-frame" as const,
          ephemeral: true as const,
          payload: { deviceMicFrameSeq: sequence, pcm },
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

  return {
    streamPath: options.streamPath,
    watch,
    clock,
    speak: (frames) =>
      new Promise<void>((resolve) => {
        pending = pending.concat(frames);
        /* An empty marker frame never leaves (the loop sends silence in its
         * place) and its disappearance from the queue is "the last real
         * frame went out". */
        const marker = "";
        pending.push(marker);
        const check = setInterval(() => {
          if (!pending.includes(marker)) {
            clearInterval(check);
            resolve();
          }
        }, 20);
      }),
    micFramesSent: () => micFramesSent,
    waitFor,
    quietFor: (quietMs) =>
      watch.lastAudioFrameAtMs !== null && clock() - watch.lastAudioFrameAtMs > quietMs,
    stop: async () => {
      stopMic = true;
      await micLoop;
      connection.close();
    },
    durableEvents: async () => {
      /* The stream handle is typed to the append surface the probes share
       * (probe-audio.ts); its read surface is asserted here to exactly the
       * one call made — a wrong assertion fails loudly at the RPC boundary. */
      const readable = stream as unknown as VoiceStreamReads;
      const events = await readable.getEvents({
        afterOffset: 0,
        eventTypes: [
          "events.iterate.com/voice-agent/conversation-accepted",
          "events.iterate.com/voice-agent/session-configured",
          "events.iterate.com/voice-agent/utterance-transcript",
          "events.iterate.com/voice-agent/answer-transcript",
          "events.iterate.com/voice-agent/backend-reply",
          "events.iterate.com/voice-agent/conversation-end-requested",
          "events.iterate.com/voice-agent/conversation-ended",
        ],
        limit: 500,
      });
      return (events ?? []).filter((event) => Date.parse(event.createdAt) >= startedAtMs - 5_000);
    },
  };
}
