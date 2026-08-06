// The "server side" of the voice pipe, runnable as a plain node process: holds one
// WebSocket to Grok Voice per call and relays both directions through the stream.
//   stream mic-frame (ephemeral)  -> grok binary audio
//   grok audio                    -> stream spk-frame (ephemeral)
//   grok control events (subset)  -> stream grok-event (ephemeral)
// An events.iterate.com/voice-agent/conversation-requested durable event starts a
// Grok session; conversation-ended (or the
// Grok socket closing) ends it. The same protocol is what a userspace worker.ts
// bridge implements — this node variant exists to isolate stream-transport latency
// from Cloudflare-side execution.
//
//   doppler run --config dev -- XAI_API_KEY=… pnpm cli voicelab bridge --project prj_… --path /voicelab/call-1
import crypto from "node:crypto";
import process from "node:process";
import { percentiles } from "./audio.ts";
import { connectProject, type VoicelabConnectOptions } from "./connect.ts";
import { GrokClient } from "./grok.ts";
import { openResilientConnection } from "./resilient.ts";
import { RpcResultObserver } from "./rpc-ownership.ts";

/** Options for `pnpm cli voicelab bridge`. */
export interface BridgeOptions extends VoicelabConnectOptions {
  /** Stream path to serve calls on. */
  path: string;
  /** Exit after the first call ends (prints a summary either way). */
  once?: boolean;
  /** Audio transport on the Grok leg. */
  grokTransport?: "binary" | "json";
  /** Text turn injected as soon as the call is accepted (Grok speaks it). */
  greet?: string;
  /**
   * Pace speaker appends at ~2x realtime instead of relaying Grok's burst
   * instantly — a constrained consumer (ESP32) takes each delivery into a
   * bounded inbox and cannot absorb hundreds of messages in one TCP clump.
   */
  paceDevice?: boolean;
}

const FORWARDED_GROK_EVENTS = new Set([
  "input_audio_buffer.speech_started",
  "input_audio_buffer.speech_stopped",
  "conversation.item.input_audio_transcription.updated",
  "conversation.item.input_audio_transcription.completed",
  "conversation.item.added",
  "response.created",
  "response.output_audio_transcript.delta",
  "response.output_audio_transcript.done",
  "response.done",
]);

export async function bridge(options: BridgeOptions) {
  const apiKey = process.env.XAI_API_KEY?.trim();
  if (!apiKey) throw new Error("XAI_API_KEY is required.");
  if (!options.path) throw new Error("--path is required.");

  using itx = await connectProject(options);
  using stream = itx.streams.get(options.path);

  let grok: GrokClient | null = null;
  let conversationId: string | null = null;
  let spkSeq = 0;
  let micFrames = 0;
  /** Frames whose payload had no usable audio; dropped, and said so. */
  let micMalformed = 0;
  let spkFrames = 0;
  let appendErrors = 0;
  let firstAppendError: string | undefined;
  const micOneWay: number[] = [];
  const micBatchSizes: number[] = [];
  let done: (() => void) | null = null;
  const finished = new Promise<void>((resolve) => {
    done = resolve;
  });

  const appendResults = new RpcResultObserver((error: unknown) => {
    appendErrors++;
    firstAppendError ??= error instanceof Error ? error.message : String(error);
  });
  const fireAppend = (...events: Parameters<typeof stream.append>) => {
    appendResults.observe(stream.append(...events));
  };

  // --pace-device: drip queued speaker events in 5-event appends every 50ms
  // (2x realtime), so a downstream bounded inbox sees a steady trickle
  // instead of Grok's burst.
  const paceQueue: Parameters<typeof stream.append>[0][] = [];
  let paceTimer: NodeJS.Timeout | null = null;
  const pacePump = () => {
    if (paceTimer !== null) return;
    paceTimer = setInterval(() => {
      const slice = paceQueue.splice(0, 5);
      if (slice.length === 0) {
        if (paceTimer !== null) clearInterval(paceTimer);
        paceTimer = null;
        return;
      }
      fireAppend(...slice);
    }, 50);
  };

  const endCall = (reason: string) => {
    if (conversationId === null) return;
    const endedConversationId = conversationId;
    conversationId = null;
    grok?.close();
    grok = null;
    fireAppend({
      type: "events.iterate.com/voice-agent/conversation-ended",
      payload: { conversationId: endedConversationId, reason },
    });
    console.error(`bridge: call ${endedConversationId} ended (${reason})`);
    printSummary();
    if (options.once) done?.();
  };

  const startCall = (payload: Record<string, unknown>) => {
    if (grok) {
      console.error("bridge: ignoring conversation-requested while a call is active");
      return;
    }
    // Checked, not asserted: the payload crossed a stream, so a non-string
    // conversationId is a thing that can actually arrive, and `??` would have let it
    // through to be used as an identity.
    conversationId =
      typeof payload.conversationId === "string"
        ? payload.conversationId
        : crypto.randomUUID().slice(0, 8);
    spkSeq = 0;
    const client = new GrokClient({
      apiKey,
      transport: options.grokTransport ?? "binary",
      ...(typeof payload.model === "string" ? { model: payload.model } : {}),
      ...(typeof payload.voice === "string" ? { voice: payload.voice } : {}),
      ...(payload.effort === "none" || payload.effort === "high"
        ? { reasoningEffort: payload.effort }
        : {}),
    });
    grok = client;
    client.connect();
    client.on("ready", () => {
      fireAppend({
        type: "events.iterate.com/voice-agent/conversation-accepted",
        payload: { conversationId, bridge: "node", model: client.options.model },
      });
      console.error(`bridge: call ${conversationId} accepted (model=${client.options.model})`);
      if (options.greet) {
        client.send({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: options.greet }],
          },
        });
        client.send({ type: "response.create" });
        console.error(`bridge: greet turn sent`);
      }
    });
    client.on("audio", (pcm: Buffer) => {
      const tGrok = Date.now();
      // Grok ships 0.4-1s frames; re-chunk to 20ms events so constrained
      // consumers (ESP32 with per-batch delivery caps) can take them. One
      // atomic append per Grok frame keeps the commit count low; delivery
      // caps split it per consumer.
      const events = [];
      for (let offset = 0; offset < pcm.length; offset += 640) {
        spkFrames++;
        events.push({
          type: "events.iterate.com/voice-agent/spk-frame",
          ephemeral: true as const,
          payload: {
            conversationId,
            seq: spkSeq++,
            t: Date.now(),
            tGrok,
            pcm: pcm.subarray(offset, offset + 640).toString("base64"),
          },
        });
      }
      if (events.length === 0) return;
      if (!options.paceDevice) {
        fireAppend(...events);
        return;
      }
      paceQueue.push(...events);
      pacePump();
    });
    client.on("event", (event: { type: string }) => {
      if (!FORWARDED_GROK_EVENTS.has(event.type)) return;
      if (event.type === "input_audio_buffer.speech_started") {
        paceQueue.length = 0; // barge-in: never drip stale response audio
      }
      fireAppend({
        type: "events.iterate.com/voice-agent/grok-event",
        ephemeral: true,
        payload: { conversationId, t: Date.now(), event },
      });
    });
    client.on("error", (error: Error) => console.error(`bridge: grok error: ${error.message}`));
    client.on("close", (code: number) => endCall(`grok socket closed (${code})`));
  };

  const connection = await openResilientConnection(stream, {
    connectionKey: `voicelab-bridge-${crypto.randomUUID().slice(0, 8)}`,
    eventTypes: [
      "events.iterate.com/voice-agent/mic-frame",
      "events.iterate.com/voice-agent/conversation-requested",
      "events.iterate.com/voice-agent/conversation-ended",
      "events.iterate.com/voice-agent/ping",
    ],
    quietMs: 4000,
    // Pings flow every 2s during a call; when idle, silence is expected and
    // reopen churn would only pollute the stream with connection facts.
    trafficExpected: () => conversationId !== null,
    onEvents: (events) => {
      let micInBatch = 0;
      for (const event of events) {
        /*
         * Everything below crosses a stream, so every field is checked rather
         * than asserted. A malformed frame is a real arrival — the provider
         * leg has been seen to send truncated JSON — and asserting would turn
         * one bad frame into a NaN latency sample or a throw inside the
         * delivery callback, which ends the call outright.
         */
        const payload: Record<string, unknown> =
          typeof event.payload === "object" && event.payload !== null
            ? (event.payload as Record<string, unknown>)
            : {};
        switch (event.type) {
          case "events.iterate.com/voice-agent/mic-frame": {
            if (typeof payload.pcm !== "string") {
              micMalformed++;
              break;
            }
            micInBatch++;
            micFrames++;
            if (typeof payload.t === "number") micOneWay.push(Date.now() - payload.t);
            grok?.sendAudio(Buffer.from(payload.pcm, "base64"));
            break;
          }
          case "events.iterate.com/voice-agent/conversation-requested":
            startCall(payload);
            break;
          case "events.iterate.com/voice-agent/conversation-ended":
            if (payload.conversationId === conversationId) endCall("client requested end");
            break;
          case "events.iterate.com/voice-agent/ping":
            fireAppend({
              type: "events.iterate.com/voice-agent/pong",
              ephemeral: true,
              payload: { id: payload.id, t0: payload.t0, t1: Date.now() },
            });
            break;
        }
      }
      if (micInBatch > 0) micBatchSizes.push(micInBatch);
    },
  });

  const printSummary = () => {
    console.log(
      JSON.stringify(
        {
          role: "bridge",
          path: options.path,
          micFrames,
          micMalformed,
          spkFrames,
          micOneWayMs: percentiles(micOneWay),
          micEventsPerBatch: percentiles(micBatchSizes),
          connection: connection.stats(),
          appendErrors,
          ...(firstAppendError === undefined ? {} : { firstAppendError }),
        },
        null,
        2,
      ),
    );
  };

  console.error(
    `bridge: listening on ${options.path} (connection open, waiting for conversation-requested)`,
  );
  process.once("SIGINT", () => {
    endCall("bridge interrupted");
    done?.();
  });
  await finished;
  await appendResults.drain();
  connection.close();
  process.exit(0);
}
