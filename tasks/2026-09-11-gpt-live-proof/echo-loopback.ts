/* A file-only GPT-Live echo-loop measurement. It renders `say -o` files but
 * never opens a microphone or speaker, persists returned audio, or calls an
 * Iterate backend. Run from apps/os:
 * doppler run --config prd -- pnpm exec tsx ../../tasks/2026-09-11-gpt-live-proof/echo-loopback.ts
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
const require = createRequire(new URL("../../apps/os/package.json", import.meta.url));
const WebSocket = require("ws");

const rate = 16_000,
  frameMs = 20,
  frameBytes = 640;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function fileSpeech(name: string, text: string): Buffer[] {
  const dir = mkdtempSync(path.join(tmpdir(), "gpt-live-echo-"));
  const aiff = path.join(dir, `${name}.aiff`),
    wav = path.join(dir, `${name}.wav`);
  try {
    for (const [program, args] of [
      ["say", ["-o", aiff, text]],
      ["afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, wav]],
    ] as const) {
      if (spawnSync(program, args).status !== 0) throw new Error(`${program} file render failed`);
    }
    const bytes = readFileSync(wav);
    let offset = 12;
    while (offset + 8 <= bytes.length) {
      const size = bytes.readUInt32LE(offset + 4);
      if (bytes.toString("ascii", offset, offset + 4) === "data") {
        const pcm = bytes.subarray(offset + 8, offset + 8 + size),
          frames: Buffer[] = [];
        for (let at = 0; at + frameBytes <= pcm.length; at += frameBytes)
          frames.push(pcm.subarray(at, at + frameBytes));
        return frames;
      }
      offset += 8 + size + (size % 2);
    }
    throw new Error("generated WAV has no data chunk");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
function half(pcm: Buffer) {
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i < pcm.length; i += 2) out.writeInt16LE(Math.trunc(pcm.readInt16LE(i) / 2), i);
  return out;
}

/** Mix the human frame and the delayed model echo at the input cadence.
 * PCM samples are signed 16-bit little-endian; clipping is explicit instead
 * of Buffer's wraparound so the probe models a saturated microphone input. */
function saturatedMix(human: Buffer, echo: Buffer): Buffer {
  const mixed = Buffer.alloc(Math.max(human.length, echo.length));
  for (let offset = 0; offset < mixed.length; offset += 2) {
    const humanSample = offset < human.length ? human.readInt16LE(offset) : 0;
    const echoSample = offset < echo.length ? echo.readInt16LE(offset) : 0;
    mixed.writeInt16LE(Math.max(-32_768, Math.min(32_767, humanSample + echoSample)), offset);
  }
  return mixed;
}

type Result = {
  case: string;
  started: boolean;
  closed: boolean;
  closeTimeout: boolean;
  closeUsage: unknown;
  elapsedMs: number;
  outputAudioMs: number;
  outputDeltas: number;
  inputTranscript: string;
  outputTranscript: string;
  inputFragments: string[];
  outputFragments: string[];
  errors: string[];
  echoedMs: number;
  mixedFrames: number;
  outputFirstAtMs: number | null;
  secondInputAtMs: number | null;
};
async function test(
  name: string,
  echo: boolean,
  barge: boolean,
  mixHumanAndEcho: boolean,
): Promise<Result> {
  const key = process.env.OPENAI_API_KEY?.trim() ?? process.env.APP_CONFIG_OPENAI_API_KEY?.trim();
  if (!key) throw new Error("OPENAI_API_KEY required through Doppler");
  const startedWall = Date.now(),
    now = () => Date.now() - startedWall;
  const result: Result = {
    case: name,
    started: false,
    closed: false,
    closeTimeout: false,
    closeUsage: null,
    elapsedMs: 0,
    outputAudioMs: 0,
    outputDeltas: 0,
    inputTranscript: "",
    outputTranscript: "",
    inputFragments: [],
    outputFragments: [],
    errors: [],
    echoedMs: 0,
    mixedFrames: 0,
    outputFirstAtMs: null,
    secondInputAtMs: null,
  };
  const first = fileSpeech("first", "Please count from one to ten slowly, then stop."),
    second = barge ? fileSpeech("second", "Now say banana once, then stop.") : [];
  const socket = new WebSocket("wss://api.openai.com/v1/live/sessions", {
    headers: {
      Authorization: `Bearer ${key}`,
      "User-Agent": "iterate-voicelab/file-only-echo-measurement",
    },
  });
  const echoes: Buffer[] = [];
  let frames: Buffer[] = [],
    echoedFrames = 0;
  let resolveClosed: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  socket.on("open", () =>
    socket.send(
      JSON.stringify({
        type: "session.start",
        event_id: "start",
        session: {
          model: "gpt-live-1",
          instructions:
            "You are a concise voice assistant. Answer the person's request directly. Do not use tools.",
          audio: { format: { type: "audio/pcm", rate }, output: { voice: "marin" } },
          delegation: { type: "client" },
        },
      }),
    ),
  );
  socket.on("error", (error) => result.errors.push(String(error)));
  socket.on("message", (raw) => {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(Buffer.from(raw as Buffer).toString("utf8")) as Record<string, unknown>;
    } catch {
      result.errors.push("unparseable event");
      return;
    }
    const type = String(event.type ?? ""),
      text = String(event.delta ?? "");
    if (type === "session.started") result.started = true;
    else if (type === "session.closed") {
      result.closed = true;
      result.closeUsage = event.usage ?? null;
      resolveClosed?.();
    } else if (type === "session.input_transcript.delta") {
      result.inputFragments.push(text);
      result.inputTranscript += text;
    } else if (type === "session.output_transcript.delta") {
      result.outputFragments.push(text);
      result.outputTranscript += text;
    } else if (type === "session.output_audio.delta") {
      const pcm = Buffer.from(text, "base64");
      result.outputDeltas++;
      result.outputAudioMs += pcm.length / 32;
      result.outputFirstAtMs ??= now();
      if (echo)
        setTimeout(() => {
          const delayed = half(pcm);
          for (let at = 0; at + frameBytes <= delayed.length; at += frameBytes)
            echoes.push(delayed.subarray(at, at + frameBytes));
        }, 100);
    } else if (type === "error") result.errors.push(JSON.stringify(event).slice(0, 400));
  });
  while (!result.started && now() < 10_000) await sleep(20);
  if (!result.started) result.errors.push("session.started timeout");
  else {
    await sleep(500);
    frames = [...first];
    const end = Date.now() + 28_000;
    let barged = false;
    while (Date.now() < end) {
      if (barge && !barged && now() >= 10_000) {
        frames.push(...second);
        barged = true;
        result.secondInputAtMs = now();
      }
      const spoken = frames.shift();
      const echoed = echo ? echoes.shift() : undefined;
      if (echoed) echoedFrames++;
      const input =
        spoken && echoed && mixHumanAndEcho
          ? (result.mixedFrames++, saturatedMix(spoken, echoed))
          : (spoken ?? echoed ?? Buffer.alloc(frameBytes));
      if (socket.readyState === WebSocket.OPEN)
        socket.send(
          JSON.stringify({
            type: "session.input_audio.append",
            audio: input.toString("base64"),
          }),
        );
      await sleep(frameMs);
    }
  }
  result.echoedMs = echoedFrames * frameMs;
  if (socket.readyState === WebSocket.OPEN)
    socket.send(JSON.stringify({ type: "session.close", event_id: "close" }));
  await Promise.race([closed, sleep(15_000)]);
  if (!result.closed) {
    result.closeTimeout = true;
    result.errors.push("session.closed timeout after 15000ms");
  }
  result.elapsedMs = now();
  socket.terminate();
  return result;
}
void (async () => {
  const cases = [
    ["baseline", false, false, false],
    ["echo_100ms_half_gain", true, false, false],
    /* This historic case sends the human phrase instead of an echo on a
     * shared cadence; it does not claim a simultaneous mixed input. */
    ["echo_100ms_half_gain_second_human", true, true, false],
    ["echo_100ms_half_gain_mixed_human", true, true, true],
  ] as const;
  const requested = process.argv.at(2);
  const selected = requested === undefined ? cases : cases.filter(([name]) => name === requested);
  if (selected.length === 0) throw new Error(`unknown echo case: ${requested}`);
  for (const [name, echo, barge, mixHumanAndEcho] of selected)
    console.log(JSON.stringify(await test(name, echo, barge, mixHumanAndEcho)));
})();
