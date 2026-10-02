// scripts/voice-call.ts — ONE voice conversation from Node, the shape the ESP32 HAVPE has: a warm
// authenticated capnweb session, then "press the button = a new stream now". The call itself is
// `@iterate-com/voice/call`'s client (the press, the subscription, the microphone appends, the
// keepalive, the terminal — prepare the project at https://k.iterate.com); this script feeds it
// microphone frames from a 16 kHz mono PCM16 WAV (or one silent frame, with `--say`'s words handed
// to the call's agent as a person's message), writes what came back to a WAV and prints the
// timeline from the press.
//
//   WORKER_BASE_URL=https://os.iterate.com ITERATE_BEARER_TOKEN=itk_… \
//   node scripts/voice-call.ts --utterance ask.wav --out answer.wav
//   node scripts/voice-call.ts --say "Say exactly: ready."
//
// ITERATE_BEARER_TOKEN is a personal access token for the project
// (`pnpm exec iterate --config prd tokens create`). PROJECT=prj-voice.
import type {} from "iterate/agents";
import type {} from "@iterate-com/voice";
import { readFileSync, writeFileSync } from "node:fs";
import { startVoiceCall } from "@iterate-com/voice/call";
import type { RpcPromise } from "capnweb";
import type { IterateContextApiWith } from "iterate/api";
import { createCli } from "trpc-cli";
import { connect } from "./client.ts";

const FRAME_MS = 50;
const BYTES_PER_MS = 32; // 16 kHz mono PCM16
const now = () => Date.now();

/** 16 kHz mono PCM16 WAV → the PCM bytes (chunk-aware: `say` writes its fmt chunk after others). */
function pcmFromWav(file: string) {
  const wav = new Uint8Array(readFileSync(file));
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const tag = (at: number) => new TextDecoder("ascii").decode(wav.subarray(at, at + 4));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error(`${file}: not a RIFF/WAVE file`);
  let format: { rate: number; channels: number; bits: number } | null = null;
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") {
      format = {
        channels: view.getUint16(body + 2, true),
        rate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      };
    } else if (id === "data") {
      if (!format) throw new Error(`${file}: data before fmt`);
      if (format.rate !== 16_000 || format.channels !== 1 || format.bits !== 16)
        throw new Error(
          `${file}: need 16 kHz mono PCM16, got ${format.rate} Hz ${format.channels} ch ${format.bits} bit`,
        );
      return wav.subarray(body, body + size);
    }
    offset = body + size + (size % 2);
  }
  throw new Error(`${file}: no data chunk`);
}

function wavFromPcm(pcm: Uint8Array): Uint8Array {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16_000, 24);
  header.writeUInt32LE(16_000 * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** ONE voice conversation on a fresh context through the call client; prints the timeline from
 *  the press. PROJECT (env) names the project, default prj-voice. */
export default async function voiceCall(
  options: {
    /** A 16 kHz mono PCM16 WAV to send as microphone frames. */
    utterance?: string;
    /** Words handed to the call's agent once the call is live, as a person's message: the live
     *  model speaks the agent's answer. */
    say?: string;
    /** Where to write what came back as a WAV; default /tmp/voice-call-<now>.wav. */
    out?: string;
    /** How long to keep the microphone open with silence after the utterance (the model answers then). */
    listenMs?: number;
  } = {},
): Promise<void> {
  const PROJECT = process.env.PROJECT || "prj-voice";
  const UTTERANCE = options.utterance;
  const SAY = options.say;
  const OUT = options.out || `/tmp/voice-call-${Date.now().toString(36)}.wav`;
  const LISTEN_MS = Number(options.listenMs || 12_000);
  if (!UTTERANCE && !SAY) throw new Error("pass --utterance <wav> or --say <text>");
  const micPcm = UTTERANCE ? pcmFromWav(UTTERANCE) : Buffer.alloc(FRAME_MS * BYTES_PER_MS);

  // ONE warm authenticated session and the project root — what a connected device holds.
  const warm0 = now();
  using connection = await connect();
  // The project's config installs voice beside the agents app (https://k.iterate.com prepares
  // both), so its root has `voice` and `agents`: the assertion iterate/api's `IterateContextApiWith`
  // documents for a root that knows its apps are there.
  const root = connection.session.projects.get(PROJECT) as RpcPromise<
    IterateContextApiWith<"voice" | "agents">
  >;
  await root.whoami();
  console.log(`session + project root ready in ${now() - warm0}ms`);

  // THE PRESS: a fresh context, its agent and the relay on it, a live callback for the answer.
  const t0 = now();
  const at = () => now() - t0;
  const marks: Record<string, number> = {};
  const speaker: Uint8Array[] = [];
  const transcript: string[] = [];
  let ended: string | null = null;
  let accepted: (() => void) | null = null;
  const acceptedPromise = new Promise<void>((resolve) => (accepted = resolve));
  const call = await startVoiceCall(root, {
    client: "cli",
    onSpeakerFrame: (frame) => {
      marks.firstSpeakerFrame ??= at();
      if (frame.pcm) speaker.push(Buffer.from(frame.pcm, "base64"));
      if (frame.lastFrameOfAnswer) marks[`answerDone#${speaker.length}`] = at();
    },
    onFact: (fact) => {
      switch (fact.type) {
        case "events.iterate.com/voice-agent/conversation-accepted":
          marks.accepted = at();
          marks.handshakeTookMs = fact.payload.handshakeTookMs;
          marks.upgradeTookMs = fact.payload.upgradeTookMs;
          accepted?.();
          break;
        case "events.iterate.com/voice-agent/call-ended":
          ended = fact.payload.reason;
          marks.ended = at();
          break;
        case "events.iterate.com/voice-agent/utterance-transcribed":
          transcript.push(`listener: ${fact.payload.text}`);
          console.log(`[${at()}ms] listener: ${fact.payload.text}`);
          break;
        case "events.iterate.com/voice-agent/answer-transcribed":
          transcript.push(`assistant: ${fact.payload.text}`);
          console.log(`[${at()}ms] assistant: ${fact.payload.text}`);
          break;
        case "events.iterate.com/agent/context-added":
          // What the relay handed the agent, and the agent's replies (a script step, or the
          // answer the live model speaks).
          if (fact.payload.role === "user")
            console.log(`[${at()}ms] to the agent: ${fact.payload.content}`);
          if (fact.payload.role === "assistant" && fact.payload.llmRequestOffset)
            console.log(`[${at()}ms] agent: ${fact.payload.content.slice(0, 300)}`);
          break;
        case "events.iterate.com/voice-agent/provider-error-reported":
        case "events.iterate.com/voice-agent/provider-disconnected":
          marks[fact.type] ??= at();
          console.log(`[${at()}ms] ${fact.type}: ${JSON.stringify(fact.payload).slice(0, 300)}`);
          break;
        default:
          marks[fact.type] ??= at();
      }
    },
  });
  marks.started = at();

  // THE MICROPHONE: 50 ms frames on a wall clock, never awaited one by one (a device's outbox),
  // then silence until the answer had its say.
  const frameBytes = FRAME_MS * BYTES_PER_MS;
  const frames: Uint8Array[] = [];
  for (let i = 0; i < micPcm.length; i += frameBytes)
    frames.push(micPcm.subarray(i, i + frameBytes));
  const silence = Buffer.alloc(frameBytes);
  const startedAt = now();
  let frameIndex = 0;
  const totalFrames = frames.length + Math.ceil(LISTEN_MS / FRAME_MS);
  marks.firstMicSent = at();
  while (frameIndex < totalFrames) {
    const due = startedAt + frameIndex * FRAME_MS;
    const wait = due - now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    const pcm = frames[frameIndex] ?? silence;
    call.sendMicFrame(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64"));
    frameIndex++;
    if (SAY && frameIndex === 1) {
      // Nothing to say into the microphone: hand the agent the words once the call is live.
      void acceptedPromise.then(() => root.agents.get(call.streamPath).message(SAY));
    }
    if (ended) break;
  }

  await call.hangUp("voice-call script done");
  marks.terminalSent = at();

  const pcm = Buffer.concat(speaker);
  writeFileSync(OUT, wavFromPcm(pcm));
  console.log(
    JSON.stringify(
      {
        project: PROJECT,
        path: call.streamPath,
        activation: call.activation,
        stats: call.stats,
        speakerMs: pcm.length / BYTES_PER_MS,
        out: OUT,
        transcript,
        ended,
        marks,
      },
      null,
      2,
    ),
  );
}

void createCli(import.meta).run();
