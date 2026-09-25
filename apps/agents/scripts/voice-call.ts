// scripts/voice-call.ts — ONE voice conversation on a FRESH context, the shape the ESP32
// HAVPE has: a warm authenticated capnweb session, then "press the button = a new stream now".
//
// It makes the device's exact calls: `root.voice.setupVoiceAgent({ streamPath, activation })` (the
// project's root worker puts the voice facet and `call-started` on the fresh context in one append;
// prepare the project at https://k.iterate.com), a live subscription for what the device would hear,
// microphone frames from a 16 kHz mono PCM16 WAV (or one silent frame plus a `commentary-added` fact
// when there is nothing to say), the terminal. It writes what came back to a WAV and prints the
// timeline from the press.
//
//   WORKER_BASE_URL=https://os.iterate.com ITERATE_BEARER_TOKEN=itk_… \
//   pnpm exec tsx scripts/voice-call.ts --utterance ask.wav --out answer.wav
//   pnpm exec tsx scripts/voice-call.ts --say "Say: ready."
//
// ITERATE_BEARER_TOKEN is a personal access token for the project
// (`pnpm exec iterate --config prd tokens create`). PROJECT=prj-voice.
import { readFileSync, writeFileSync } from "node:fs";
import { isMainModule } from "@iterate-com/shared/dev/is-main-module";
import { createCli } from "trpc-cli";
import { credentials, disposeSessions, session } from "./client.ts";

const FRAME_MS = 50;
const BYTES_PER_MS = 32; // 16 kHz mono PCM16
const now = () => Date.now();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

/** ONE voice conversation on a fresh context, making exactly the device's calls; prints the
 *  timeline from the press. PROJECT (env) names the project, default prj-voice. */
export default async function voiceCall(
  options: {
    /** The fresh context's path; default /calls/<now>. */
    path?: string;
    /** A 16 kHz mono PCM16 WAV to send as microphone frames. */
    utterance?: string;
    /** Text sent as a `commentary-added` fact after one silent frame. */
    say?: string;
    /** Where to write what came back as a WAV; default /tmp/voice-call-<now>.wav. */
    out?: string;
    /** How long to keep the microphone open with silence after the utterance (the model answers then). */
    listenMs?: number;
  } = {},
): Promise<void> {
  const PROJECT = process.env.PROJECT || "prj-voice";
  const CONTEXT_PATH = options.path || `/calls/${Date.now().toString(36)}`;
  const UTTERANCE = options.utterance;
  const SAY = options.say;
  const OUT = options.out || `/tmp/voice-call-${Date.now().toString(36)}.wav`;
  const LISTEN_MS = Number(options.listenMs || 12_000);
  if (!UTTERANCE && !SAY) throw new Error("pass --utterance <wav> or --say <text>");
  const micPcm = UTTERANCE ? pcmFromWav(UTTERANCE) : Buffer.alloc(FRAME_MS * BYTES_PER_MS);

  // ONE warm authenticated session and the project root — what a connected device holds.
  const api = session();
  const root = api.authenticate(credentials()).projects.get(PROJECT);
  const warm0 = now();
  await root.invoke(["itx", ["whoami"]]);
  console.log(`session + project root ready in ${now() - warm0}ms`);

  // THE PRESS: a fresh context, the processor enabled on it, a live callback for the answer.
  const itx = root.cd(CONTEXT_PATH);
  const t0 = now();
  const at = () => now() - t0;
  const activation = crypto.randomUUID().replace(/-/g, "");
  const marks: Record<string, number> = {};
  const speaker: Uint8Array[] = [];
  const transcript: string[] = [];
  let ended: string | null = null;
  let accepted: (() => void) | null = null;
  const acceptedPromise = new Promise<void>((resolve) => (accepted = resolve));

  // THE PRESS: the root worker appends the voice facet's subscription row and `call-started` on
  // this fresh context in one append. PIPELINED with the subscription below: neither depends on
  // the other's answer, so both go out now.
  const setupPromise = Promise.resolve(
    root.voice.setupVoiceAgent({ streamPath: CONTEXT_PATH, activation }),
  ).then((result: unknown) => {
    marks.setup = at();
    const parsed = JSON.parse(JSON.stringify(result)) as {
      streamPath: string;
    };
    return parsed;
  });

  await itx.subscribe({
    name: "device",
    consumes: [
      "events.iterate.com/voice-agent/call-started",
      "events.iterate.com/voice-agent/conversation-accepted",
      "events.iterate.com/voice-agent/conversation-ended",
      "events.iterate.com/voice-agent/spk-frame",
      "events.iterate.com/voice-agent/utterance-transcribed",
      "events.iterate.com/voice-agent/answer-transcribed",
      "events.iterate.com/voice-agent/delegation-requested",
      "events.iterate.com/voice-agent/provider-error-reported",
      "events.iterate.com/voice-agent/provider-disconnected",
    ],
    target: (events: any[]) => {
      for (const raw of events) {
        const event = JSON.parse(JSON.stringify(raw));
        const p = event.payload ?? {};
        switch (event.type) {
          case "events.iterate.com/voice-agent/spk-frame":
            marks.firstSpkFrame ??= at();
            if (p.pcm) speaker.push(Buffer.from(p.pcm, "base64"));
            if (p.lastFrameOfAnswer) marks[`answerDone#${speaker.length}`] = at();
            break;
          case "events.iterate.com/voice-agent/conversation-accepted":
            marks.accepted = at();
            marks.handshakeTookMs = p.handshakeTookMs;
            marks.upgradeTookMs = p.upgradeTookMs;
            accepted?.();
            break;
          case "events.iterate.com/voice-agent/conversation-ended":
            ended = String(p.reason);
            marks.ended = at();
            break;
          case "events.iterate.com/voice-agent/utterance-transcribed":
            transcript.push(`listener: ${p.text}`);
            console.log(`[${at()}ms] listener: ${p.text}`);
            break;
          case "events.iterate.com/voice-agent/answer-transcribed":
            transcript.push(`assistant: ${p.text}`);
            console.log(`[${at()}ms] assistant: ${p.text}`);
            break;
          case "events.iterate.com/voice-agent/delegation-requested":
            console.log(
              `[${at()}ms] delegation ${p.delegationId} with ${p.transcript?.length ?? 0} turns`,
            );
            break;
          default:
            marks[event.type] ??= at();
            if (
              event.type === "events.iterate.com/voice-agent/provider-error-reported" ||
              event.type === "events.iterate.com/voice-agent/provider-disconnected"
            )
              console.log(`[${at()}ms] ${event.type}: ${JSON.stringify(p).slice(0, 300)}`);
        }
      }
    },
  });
  marks.subscribed = at();
  const setup = await setupPromise;
  if (setup.streamPath !== CONTEXT_PATH) throw new Error(`setup answered ${JSON.stringify(setup)}`);

  // THE MICROPHONE: 50 ms frames on a wall clock, never awaited one by one (a device's outbox),
  // then silence until the answer had its say. The call itself was minted by the press's
  // `call-started` append.
  let pending = 0;
  let failed = 0;
  const sendFrame = (pcm: Uint8Array) => {
    pending++;
    Promise.resolve(
      itx.append({
        type: "events.iterate.com/voice-agent/mic-frame",
        ephemeral: true,
        payload: {
          activation,
          pcm: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64"),
        },
      }),
    ).then(
      () => pending--,
      (error: unknown) => {
        pending--;
        failed++;
        if (failed <= 3) console.log(`mic append failed: ${String(error).slice(0, 200)}`);
      },
    );
  };
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
    if (wait > 0) await sleep(wait);
    sendFrame(frames[frameIndex] ?? silence);
    frameIndex++;
    if (SAY && frameIndex === 1) {
      // Nothing to say into the microphone: hand the model a fact to paraphrase once the call is live.
      void acceptedPromise.then(() =>
        itx.append({
          type: "events.iterate.com/voice-agent/commentary-added",
          payload: { activation, delegationId: null, content: SAY },
        }),
      );
    }
    if (ended) break;
  }
  while (pending > 0) await sleep(20);

  await itx.append({
    type: "events.iterate.com/voice-agent/conversation-ended",
    payload: { activation, reason: "voice-call script done" },
  });
  marks.terminalSent = at();
  await sleep(500);

  const pcm = Buffer.concat(speaker);
  writeFileSync(OUT, wavFromPcm(pcm));
  console.log(
    JSON.stringify(
      {
        project: PROJECT,
        path: CONTEXT_PATH,
        activation,
        micFrames: frameIndex,
        micAppendFailures: failed,
        speakerFrames: speaker.length,
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
  disposeSessions();
}

if (isMainModule(import.meta.url)) void createCli({ ...import.meta, name: "voice-call" }).run();
