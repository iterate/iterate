// The "server side" of the voice pipe, runnable as a plain node process: holds one
// WebSocket to Grok Voice per call and relays both directions through the stream.
//   stream mic-frame (ephemeral)  -> grok binary audio
//   grok audio                    -> stream spk-frame (ephemeral)
//   grok control events (subset)  -> stream grok-event (ephemeral)
// A voicelab/call-requested durable event starts a Grok session; call-ended (or the
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
  let callId: string | null = null;
  let spkSeq = 0;
  let micFrames = 0;
  let spkFrames = 0;
  let appendErrors = 0;
  let firstAppendError: string | undefined;
  const micOneWay: number[] = [];
  const micBatchSizes: number[] = [];
  let done: (() => void) | null = null;
  const finished = new Promise<void>((resolve) => {
    done = resolve;
  });

  const fireAppend = (...events: Parameters<typeof stream.append>) => {
    stream.append(...events).catch((error: unknown) => {
      appendErrors++;
      firstAppendError ??= error instanceof Error ? error.message : String(error);
    });
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
    if (callId === null) return;
    const endedCallId = callId;
    callId = null;
    grok?.close();
    grok = null;
    fireAppend({ type: "voicelab/call-ended", payload: { callId: endedCallId, reason } });
    console.error(`bridge: call ${endedCallId} ended (${reason})`);
    printSummary();
    if (options.once) done?.();
  };

  const startCall = (payload: Record<string, unknown>) => {
    if (grok) {
      console.error("bridge: ignoring call-requested while a call is active");
      return;
    }
    callId = (payload.callId as string) ?? crypto.randomUUID().slice(0, 8);
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
        type: "voicelab/call-accepted",
        payload: { callId, bridge: "node", model: client.options.model },
      });
      console.error(`bridge: call ${callId} accepted (model=${client.options.model})`);
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
          type: "voicelab/spk-frame",
          ephemeral: true as const,
          payload: {
            callId,
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
        type: "voicelab/grok-event",
        ephemeral: true,
        payload: { callId, t: Date.now(), event },
      });
    });
    client.on("error", (error: Error) => console.error(`bridge: grok error: ${error.message}`));
    client.on("close", (code: number) => endCall(`grok socket closed (${code})`));
  };

  const connection = await openResilientConnection(stream, {
    connectionKey: `voicelab-bridge-${crypto.randomUUID().slice(0, 8)}`,
    eventTypes: [
      "voicelab/mic-frame",
      "voicelab/call-requested",
      "voicelab/call-ended",
      "voicelab/ping",
    ],
    quietMs: 4000,
    // Pings flow every 2s during a call; when idle, silence is expected and
    // reopen churn would only pollute the stream with connection facts.
    trafficExpected: () => callId !== null,
    onEvents: (events) => {
      let micInBatch = 0;
      for (const event of events) {
        const payload = event.payload as Record<string, unknown>;
        switch (event.type) {
          case "voicelab/mic-frame": {
            micInBatch++;
            micFrames++;
            micOneWay.push(Date.now() - (payload.t as number));
            grok?.sendAudio(Buffer.from(payload.pcm as string, "base64"));
            break;
          }
          case "voicelab/call-requested":
            startCall(payload);
            break;
          case "voicelab/call-ended":
            if ((payload.callId as string) === callId) endCall("client requested end");
            break;
          case "voicelab/ping":
            fireAppend({
              type: "voicelab/pong",
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
    `bridge: listening on ${options.path} (connection open, waiting for call-requested)`,
  );
  process.on("SIGINT", () => {
    endCall("bridge interrupted");
    printSummary();
    process.exit(0);
  });
  await finished;
  connection.close();
  process.exit(0);
}
