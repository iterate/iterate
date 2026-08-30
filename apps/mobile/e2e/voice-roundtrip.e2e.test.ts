// The phone's voice call, live from Node — the grill's headless wire-driver:
// the SAME shipped modules (voice-call.ts, voice-setup.ts, voice-pcm.ts) run
// against a real deployment's voice-agent facet, with the audio session faked
// from `say`-synthesized speech instead of a microphone. Proves everything
// except native audio before a phone build exists: setup, the durable press,
// the ephemeral mic-frames, real spk-frames coming back, and the durable
// transcript landing.
//
//   doppler run --config prd -- pnpm --dir apps/mobile test:e2e -- voice-roundtrip
//
// Against prd this uses the voicelab-eval project (the voice evals' home,
// where the 16.0.0 guest worker and the openai secret already live); any
// env whose configured project carries the voice agent works.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { connectItx } from "iterate/node";
import { startVoiceCall, type VoiceCallStatus } from "../src/lib/voice-call.ts";
import { chatVoiceStreamPath, ensureVoiceAgentSetup } from "../src/lib/voice-setup.ts";
import { pcm16Base64ToFloat32, pulseLevel } from "../src/lib/voice-pcm.ts";
import { uint8ArrayToBase64 } from "../src/lib/encoding.ts";
import { requireEnv, resolveBaseUrl } from "./e2e-helpers.ts";

const VOICE_E2E_PROJECT = process.env.VOICE_E2E_PROJECT || "voicelab-eval";

test("calling a chat: speak, be answered, and the conversation lands on the chat's stream", async () => {
  const baseUrl = resolveBaseUrl();
  using session = connectItx({
    baseUrl,
    auth: { type: "admin-secret", secret: requireEnv("APP_CONFIG_ADMIN_API_SECRET") },
  });
  const projectHandle = (session as any).projects.get(VOICE_E2E_PROJECT);
  const { projectId } = await projectHandle.__describe();
  using project = connectItx({
    baseUrl,
    auth: { type: "admin-secret", secret: requireEnv("APP_CONFIG_ADMIN_API_SECRET") },
    projectId,
  });

  /* A fresh "chat" per run — the per-chat mode covers strictly more than
   * the device line did: the certificate's colleaguePath, the call-start
   * colleague link, and the transcript subscription onto the chat's stream. */
  const chatPath = `/agents/mobile/e2e-${Date.now().toString(36)}`;
  const streamPath = chatVoiceStreamPath(chatPath);
  const markers = new Map<string, string>();

  const statuses: VoiceCallStatus[] = [];
  const audio = makeSpeechFedAudio(
    "Hello. Please say the words purple lantern back to me, and then count from one to five.",
  );

  const call = await startVoiceCall({
    stream: (project as any).streams.get(streamPath),
    audio: audio.session,
    ensureSetup: () =>
      ensureVoiceAgentSetup({
        workers: { get: (ref) => (project as any).workers.get(ref) },
        repo: (project as any).repo,
        streamPath,
        colleaguePath: chatPath,
        readMarker: async (p) => markers.get(p) ?? null,
        writeMarker: async (p, marker) => {
          markers.set(p, marker);
        },
      }),
    onStatus: (status) => statuses.push(status),
    onLevel: () => {},
    now: () => Date.now(),
  });

  /* Push-to-talk: hold, speak the whole utterance (the FIRST press is the
   * mint — the facet holds mic frames through the provider handshake and
   * commits the held turn on release), release. */
  call.setTalking(true);
  await audio.speakUtterance();
  call.setTalking(false);

  /* Let the answer FINISH before hanging up — a hang-up mid-answer drops
   * the provider socket before its transcript.done edge, so the durable
   * transcript (what the phone's captions and the transcript CLI read)
   * only exists for completed turns. The poll therefore proves both the
   * downlink audio AND the finished turn's durable record. */
  let answers: any[] = [];
  const deadline = Date.now() + 120_000;
  while (answers.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    answers = await (project as any).streams.get(streamPath).getEvents({
      afterOffset: 0,
      eventTypes: ["events.iterate.com/voice-agent/answer-transcript"],
      limit: 50,
    });
  }
  await call.hangUp();

  expect(statuses[0]).toMatchObject({ phase: "connecting" });
  expect(statuses.some((s) => s.caption === "hold the mic to talk")).toBe(true);
  expect(statuses.some((s) => s.caption === "listening…")).toBe(true);
  expect(audio.playedMs()).toBeGreaterThan(400);
  expect(answers.length).toBeGreaterThan(0);
  expect(String(answers[0].payload.text).length).toBeGreaterThan(0);

  /* THE CONVERSATION ON THE CHAT'S STREAM: the transcript subscription copies both
   * sides onto the colleague (the chat) as developer context items. The
   * listener's transcription can lag the answer, so poll for both sides. */
  let voiceLines: string[] = [];
  const copyDeadline = Date.now() + 60_000;
  while (Date.now() < copyDeadline) {
    const contextItems = await (project as any).streams.get(chatPath).getEvents({
      afterOffset: 0,
      eventTypes: ["events.iterate.com/agents/context-added"],
      limit: 100,
    });
    voiceLines = contextItems
      .map((event: any) => String(event.payload?.content ?? ""))
      .filter((content: string) => content.startsWith("<voice-turn"));
    if (
      voiceLines.some((line) => line.includes('speaker="person"')) &&
      voiceLines.some((line) => line.includes('speaker="assistant"'))
    ) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  expect(voiceLines.some((line) => line.includes('speaker="person"'))).toBe(true);
  expect(voiceLines.some((line) => line.includes('speaker="assistant"'))).toBe(true);
}, 210_000);

/* ------------------------------------------------------------- fixtures --- */

/**
 * The audio session fed by macOS `say` instead of a microphone. The "mic"
 * hears silence until `speakUtterance()` is called — which matters because
 * the call core now opens the mic during RINGING (for the ring tone's
 * output path), long before the driver holds the button; a fake that
 * started talking at start() spent the whole utterance into a closed mic.
 * `speakUtterance` plays the utterance in ~64ms frames at real-time
 * cadence plus half a second of trailing silence, then resolves — that is
 * when the driver releases. `play` counts decoded milliseconds instead of
 * making sound.
 */
function makeSpeechFedAudio(text: string) {
  const utterance = synthesizePcm16(text);
  const frameSamples = 1024;
  let playedSamples = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let cursor: number | null = null; /* null = idle mic (silence) */
  let resolveSpoken: (() => void) | null = null;

  return {
    playedMs: () => playedSamples / 16,
    speakUtterance: () =>
      new Promise<void>((resolve) => {
        cursor = 0;
        resolveSpoken = resolve;
      }),
    session: {
      start: async (onFrame: (frame: { pcmBase64: string; level: number }) => void) => {
        timer = setInterval(() => {
          let bytes: Uint8Array;
          if (cursor === null) {
            bytes = new Uint8Array(frameSamples * 2); /* an idle mic hears silence */
          } else {
            bytes =
              cursor < utterance.length
                ? utterance.subarray(cursor, cursor + frameSamples * 2)
                : new Uint8Array(frameSamples * 2);
            cursor += frameSamples * 2;
            if (cursor >= utterance.length + frameSamples * 2 * 8) {
              /* Spoken plus ~half a second of trailing silence while still
               * held, so the committed turn does not end mid-word. */
              cursor = null;
              resolveSpoken?.();
              resolveSpoken = null;
            }
          }
          onFrame({
            pcmBase64: uint8ArrayToBase64(bytes),
            level: pulseLevel(pcm16Base64ToFloat32(uint8ArrayToBase64(bytes))),
          });
        }, 64);
      },
      play: (pcmBase64: string) => {
        playedSamples += pcm16Base64ToFloat32(pcmBase64).length;
      },
      clearPlayback: () => {},
      setOutput: () => {},
      stop: async () => {
        if (timer !== null) clearInterval(timer);
        timer = null;
      },
    },
  };
}

/** `say` → PCM16 mono 16 kHz bytes (the probe-audio.ts recipe, local so the
 * mobile tsconfig never reaches into apps/os). */
function synthesizePcm16(text: string): Uint8Array {
  const dir = mkdtempSync(path.join(tmpdir(), "mobile-voice-e2e-"));
  try {
    const aiff = path.join(dir, "utterance.aiff");
    const wav = path.join(dir, "utterance.wav");
    execFileSync("say", ["-o", aiff, text]);
    execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", aiff, wav]);
    const bytes = readFileSync(wav);
    let offset = 12;
    while (offset + 8 <= bytes.length) {
      const id = bytes.toString("ascii", offset, offset + 4);
      const size = bytes.readUInt32LE(offset + 4);
      if (id === "data") return new Uint8Array(bytes.subarray(offset + 8, offset + 8 + size));
      offset += 8 + size + (size % 2);
    }
    throw new Error("no data chunk in synthesized wav");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
