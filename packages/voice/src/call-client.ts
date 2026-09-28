// call-client.ts — ONE voice call from a client, the device's calls: the press opens a fresh context
// at `/agents/voice/<client>/<UTC yyyymmddHHMMSS>-<activation>` (`itx.voice.setupVoiceAgent` puts the
// relay and the agent on it and starts the call, pipelined with a subscription for the answer's
// frames and the call's facts); microphone frames go up as ephemeral `mic-frame` appends, a
// `keepalive` every 20 s says the caller is still there through a quiet stretch, and hanging up
// appends `call-ended`. apps/voice's page runs it with the browser's worklets and
// apps/agents/scripts/voice-call.ts from Node with WAV files; Kit's firmware speaks the same calls
// in C (apps/kit/firmware/components/voice/src/voice_loop.c).
import { z } from "zod";
import type { IterateContextApi } from "iterate/api";
import type { VoiceApi } from "./api.ts";

/** How often a live call says `keepalive`: the relay reaps a call after 60 s without device input,
 *  and a caller who listens quietly sends none. */
export const VOICE_CALL_KEEPALIVE_MS = 20_000;

/** A slow link drops microphone frames rather than queueing them: at most this many appends in
 *  flight at once. */
const MAX_MIC_FRAMES_IN_FLIGHT = 5;

/** How long hanging up waits for a `call-ended` to come back through the subscription before it
 *  ends it. The subscription delivers in log order, so once the echo is here every speaker frame
 *  the relay wrote before the end has reached `onSpeakerFrame`. */
const HANG_UP_ECHO_MS = 2_000;

/** One chunk of the answer as the relay wrote it: 16 kHz mono PCM16, base64 (empty on a frame that
 *  only marks the answer's end). */
export type VoiceCallSpeakerFrame = {
  pcm: string;
  /** Throw away everything queued, then play this frame. */
  clearSpeakerBufferBeforeFrame?: boolean;
  /** Nothing more is coming for this answer. */
  lastFrameOfAnswer?: boolean;
};

const SpeakerFrame = z.object({
  type: z.literal("events.iterate.com/voice-agent/speaker-frame"),
  payload: z.looseObject({
    activation: z.string(),
    pcm: z.string(),
    clearSpeakerBufferBeforeFrame: z.boolean().optional(),
    lastFrameOfAnswer: z.boolean().optional(),
  }),
});

/** The call's facts, as much of each payload as a caller reads (voice-agent.ts's contract and
 *  packages/agents' write them; their other fields pass through). */
const VoiceCallFact = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("events.iterate.com/voice-agent/call-started"),
    payload: z.looseObject({ conversationId: z.string() }),
  }),
  z.object({
    type: z.literal("events.iterate.com/voice-agent/conversation-accepted"),
    payload: z.looseObject({ handshakeTookMs: z.number(), upgradeTookMs: z.number() }),
  }),
  z.object({
    type: z.literal("events.iterate.com/voice-agent/call-ended"),
    payload: z.looseObject({ reason: z.string() }),
  }),
  z.object({
    type: z.literal("events.iterate.com/voice-agent/utterance-transcribed"),
    payload: z.looseObject({ text: z.string() }),
  }),
  z.object({
    type: z.literal("events.iterate.com/voice-agent/answer-transcribed"),
    payload: z.looseObject({ text: z.string() }),
  }),
  // What the relay hands the call's agent, and the agent's replies (packages/agents' contract).
  z.object({
    type: z.literal("events.iterate.com/agent/context-added"),
    payload: z.looseObject({
      role: z.string(),
      content: z.string(),
      llmRequestOffset: z.number().optional(),
    }),
  }),
  z.object({
    type: z.literal("events.iterate.com/voice-agent/provider-error-reported"),
    payload: z.looseObject({ message: z.string() }),
  }),
  z.object({
    type: z.literal("events.iterate.com/voice-agent/provider-disconnected"),
    payload: z.looseObject({ reason: z.string() }),
  }),
]);
export type VoiceCallFact = z.infer<typeof VoiceCallFact>;

/** What this client saw of the call, counted here because the relay cannot see the last hop. */
export type VoiceCallStats = {
  micFramesSent: number;
  /** Frames offered while five appends were still in flight (a slow link). */
  micFramesDropped: number;
  /** Frames whose append failed. */
  micFramesFailed: number;
  spkChunksReceived: number;
  spkMsReceived: number;
  handshakeMs: number | null;
};

export type VoiceCall<Context> = {
  /** The call's own context: what a live-state view subscribes to, and where a caller appends
   *  anything else the call carries. */
  itx: Context;
  streamPath: string;
  activation: string;
  stats: VoiceCallStats;
  /** Append one microphone frame (16 kHz mono PCM16, base64) without waiting for it; false when
   *  the link is too slow and the frame was dropped. */
  sendMicFrame(pcm: string): boolean;
  /** Stop the microphone and the keepalive, wait for the frames in flight, append `call-ended`
   *  with `reason`, wait (at most 2 s) for the answer's last frames to arrive, and end the
   *  subscription. */
  hangUp(reason: string): Promise<void>;
};

/** Place a call on `project` (a root whose `itx.voice` is installed). `client` names the caller
 *  in the call's path (`web`, `cli`); `onSpeakerFrame` gets the answer's frames for this call,
 *  `onFact` the call's facts, both in log order. Resolves once the press has landed and the
 *  subscription is live. */
export async function startVoiceCall<
  Context extends Pick<IterateContextApi, "subscribe" | "append">,
>(
  project: { voice: Pick<VoiceApi, "setupVoiceAgent">; cd(path: string): Context },
  options: {
    client: string;
    onSpeakerFrame(frame: VoiceCallSpeakerFrame): void;
    onFact(fact: VoiceCallFact): void;
  },
): Promise<VoiceCall<Context>> {
  const { client, onSpeakerFrame, onFact } = options;
  const activation = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
  const streamPath = `/agents/voice/${client}/${stamp}-${activation}`;
  const itx = project.cd(streamPath);
  const stats: VoiceCallStats = {
    micFramesSent: 0,
    micFramesDropped: 0,
    micFramesFailed: 0,
    spkChunksReceived: 0,
    spkMsReceived: 0,
    handshakeMs: null,
  };
  const callEnded = Promise.withResolvers<void>();
  // THE PRESS, pipelined with the subscription: neither waits for the other's answer.
  const [{ streamPath: settledPath }, subscription] = await Promise.all([
    project.voice.setupVoiceAgent({ streamPath, activation }),
    itx.subscribe({
      name: `${client}-${activation}`,
      consumes: [
        "events.iterate.com/voice-agent/speaker-frame",
        ...VoiceCallFact.options.map((fact) => fact.shape.type.value),
      ],
      target: (events) => {
        for (const event of events) {
          const frame = SpeakerFrame.safeParse(event);
          if (frame.success) {
            if (frame.data.payload.activation !== activation) continue;
            if (frame.data.payload.pcm) {
              stats.spkChunksReceived += 1;
              // base64 carries 3 bytes in every 4 characters; PCM16 at 16 kHz is 32 bytes a millisecond
              const bytes = Math.floor((frame.data.payload.pcm.replace(/=+$/, "").length * 3) / 4);
              stats.spkMsReceived += bytes / 32;
            }
            onSpeakerFrame(frame.data.payload);
            continue;
          }
          const fact = VoiceCallFact.safeParse(event);
          if (!fact.success) continue;
          if (fact.data.type === "events.iterate.com/voice-agent/conversation-accepted")
            stats.handshakeMs = fact.data.payload.handshakeTookMs;
          if (fact.data.type === "events.iterate.com/voice-agent/call-ended") callEnded.resolve();
          onFact(fact.data);
        }
      },
    }),
  ]);
  if (settledPath !== streamPath)
    throw new Error(`setupVoiceAgent answered ${settledPath} for ${streamPath}`);

  const inFlight = new Set<Promise<unknown>>();
  let open = true;
  const keepalive = setInterval(() => {
    void itx
      .append({ type: "events.iterate.com/voice-agent/keepalive", ephemeral: true, payload: {} })
      .catch(() => undefined);
  }, VOICE_CALL_KEEPALIVE_MS);
  return {
    itx,
    streamPath,
    activation,
    stats,
    sendMicFrame(pcm) {
      if (!open) return false;
      if (inFlight.size >= MAX_MIC_FRAMES_IN_FLIGHT) {
        stats.micFramesDropped += 1;
        return false;
      }
      stats.micFramesSent += 1;
      const sent = itx
        .append({
          type: "events.iterate.com/voice-agent/mic-frame",
          ephemeral: true,
          payload: { activation, pcm },
        })
        .catch(() => {
          stats.micFramesFailed += 1;
        })
        .finally(() => inFlight.delete(sent));
      inFlight.add(sent);
      return true;
    },
    async hangUp(reason) {
      open = false;
      clearInterval(keepalive);
      await Promise.all(inFlight);
      const appended = await itx
        .append({
          type: "events.iterate.com/voice-agent/call-ended",
          payload: { activation, reason },
        })
        .then(
          () => true,
          () => false,
        );
      if (appended) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          callEnded.promise,
          new Promise((resolve) => (timer = setTimeout(resolve, HANG_UP_ECHO_MS))),
        ]);
        clearTimeout(timer);
      }
      try {
        subscription[Symbol.dispose]();
      } catch {
        // the session may already be gone
      }
    },
  };
}
