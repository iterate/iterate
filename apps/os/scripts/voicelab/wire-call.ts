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
  /** Call clock at every audio-carrying speaker frame, with its length and
   * how many audio frames shared its delivery batch — the cadence the device
   * actually sees. */
  spkArrivals: {
    atMs: number;
    payloadMs: number;
    batchAudioFrames: number;
    /** The facet's clock when it sent the frame (`sentAtFacetMs`). */
    sentAtFacetMs: number | null;
  }[];
  /** Facet clock at every audio-carrying provider delta, off the mirror
   * (`receivedAtFacetMs`): the provider→facet cadence. */
  providerDeltaReceivedAtFacetMs: number[];
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
  options: VoicelabConnectOptions & {
    streamPath: string;
    /** Microphone frames per append (20 ms each); 25 = one append every 500 ms.
     * A board sends ~8; smaller batches load the facet more evenly. */
    micBatchFrames?: number;
    /** Frames joined into ONE mic event (default 1): the same audio as fewer,
     * longer events — is the facet's cost per event or per byte? */
    micEventFrames?: number;
  },
): Promise<WireCall> {
  const micBatchFrames = options.micBatchFrames ?? 25;
  const micEventFrames = Math.max(1, options.micEventFrames ?? 1);
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
    spkArrivals: [],
    providerDeltaReceivedAtFacetMs: [],
  };

  const connection = await stream.openConnection({
    connectionKey: `wire-call-${Date.now()}`,
    eventTypes: [
      "events.iterate.com/voice-agent/spk-frame",
      "events.iterate.com/voice-agent/grok-event",
    ],
    processEventBatch: (batch: { events?: { type: string; payload?: unknown }[] }) => {
      const batchAudioFrames = (batch.events ?? []).filter(
        (event) =>
          event.type === "events.iterate.com/voice-agent/spk-frame" &&
          typeof (event.payload as { pcm?: unknown } | undefined)?.pcm === "string" &&
          (event.payload as { pcm: string }).pcm !== "",
      ).length;
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
            watch.spkArrivals.push({
              atMs: clock(),
              payloadMs: deliveredMsOf(pcm),
              batchAudioFrames,
              sentAtFacetMs:
                typeof payload.sentAtFacetMs === "number" ? payload.sentAtFacetMs : null,
            });
          }
          continue;
        }
        const type = String(payload.type ?? "");
        watch.providerEventCounts[type] = (watch.providerEventCounts[type] ?? 0) + 1;
        if (
          type === "session.output_audio.delta" &&
          typeof payload.deltaBytes === "number" &&
          payload.deltaBytes > 0 &&
          typeof payload.receivedAtFacetMs === "number"
        ) {
          watch.providerDeltaReceivedAtFacetMs.push(payload.receivedAtFacetMs);
        }
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

  /* THE MICROPHONE NEVER STOPS: one loop, `micBatchFrames` frames per append. */
  let pending: string[] = [];
  let micFramesSent = 0;
  let stopMic = false;
  const micLoop = (async () => {
    const startedAt = Date.now();
    let sequence = 0;
    while (!stopMic) {
      const due = startedAt + (sequence + micBatchFrames) * FRAME_MS;
      const wait = due - Date.now();
      if (wait > 0) await sleep(wait);
      const events = [];
      const frames: string[] = [];
      for (let index = 0; index < micBatchFrames; index++) {
        /* The empty string is speak()'s end marker, never audio: it leaves
         * the queue here and silence goes out in its place. */
        const next = pending.shift();
        frames.push(next === undefined || next === "" ? SILENCE_FRAME : next);
      }
      for (let index = 0; index < frames.length; index += micEventFrames) {
        const group = frames.slice(index, index + micEventFrames);
        /* Base64 of concatenated PCM is not the concatenation of the base64
         * (640 bytes is not a multiple of 3), so join the bytes. */
        const pcm =
          group.length === 1
            ? group[0]!
            : Buffer.concat(group.map((frame) => Buffer.from(frame, "base64"))).toString("base64");
        events.push({
          type: "events.iterate.com/voice-agent/mic-frame" as const,
          ephemeral: true as const,
          payload: { deviceMicFrameSeq: sequence, pcm },
        });
        sequence += group.length;
      }
      micFramesSent += micBatchFrames;
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
