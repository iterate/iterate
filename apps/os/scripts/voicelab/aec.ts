// Does the echo canceller work? Ask the microphone, not the datasheet.
//
//   doppler run --config preview_3 -- pnpm cli voicelab aec \
//     --project <slug> --board stackchan
//
// THE METHOD. The board says a known sentence out loud; this process records
// what the board's OWN microphone sent back over the same call, and compares
// it against the same microphone recorded while the room was quiet. An echo
// canceller that works makes those two recordings the same recording. One that
// does not leaves the sentence in the second one, and then everything
// downstream — the provider's voice activity detector, its transcriber, the
// barge-in gate — is being fed the assistant's own voice and told it is the
// customer's.
//
// TWO INSTRUMENTS, BECAUSE ONE OF THEM CAN BE FOOLED.
//
//   * ERLE, in dB: how far the microphone's energy during playback sits above
//     the same microphone's energy in silence. This is the honest number and
//     it is the one to calibrate against.
//   * A TRANSCRIPT of the playback-window recording, from whisper. This is the
//     number that convinces: 6 dB of residual is an argument, and "the mic
//     heard 'the quick brown fox' while the room was empty" is not.
//
// The energy measure alone is not enough because a canceller can leave a
// residual that is quiet and still perfectly intelligible — suppression is
// frequency-dependent and speech survives at a level a broadband RMS calls
// noise. The transcript alone is not enough either: whisper hallucinates on
// near-silence, so a run needs the level to interpret the words.
//
// NO GROK IN THE LOOP, on purpose. The answer audio comes from the fake
// provider saying a fixed sentence through this Mac's `say`, so the far-end
// signal is byte-identical between runs and between boards, and a difference
// in the measurement is a difference in the hardware. `--real` exists for the
// last step, where the question stops being "does the canceller work" and
// becomes "does the provider's own detector agree".
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import type { DynamicWorkerCapability } from "iterate/sdk";

import { mulawToPcm16, SAMPLE_RATE } from "./audio.ts";
import { connectProject, deviceCapability, type VoicelabConnectOptions } from "./connect.ts";
import { installVoiceAgent } from "./deploy.ts";
import { startFakeGrok } from "./fake-grok.ts";
import { discardRpcResult, withRpcResult } from "./rpc-ownership.ts";
import { voiceAgentEntrypointRef } from "./voice-agent-ref.ts";

const MIC_FRAME = "events.iterate.com/voice-agent/mic-frame";
const SPK_FRAME = "events.iterate.com/voice-agent/spk-frame";
const PTT_START = "events.iterate.com/voice-agent/ptt-start";
const PTT_END = "events.iterate.com/voice-agent/ptt-end";
const WARMUP = "events.iterate.com/voice-agent/warmup";
const GROK_EVENT = "events.iterate.com/voice-agent/grok-event";

/**
 * The sentence the board says while its own microphone is being watched.
 *
 * Two pangrams: every phoneme, no repetition a transcriber could pattern-match
 * its way to, and nothing a room could plausibly say by accident — so a word
 * from it turning up in the microphone transcript has exactly one explanation.
 */
const DEFAULT_SENTENCE =
  "The quick brown fox jumps over the lazy dog. " +
  "Pack my box with five dozen liquor jugs. " +
  "How razorback jumping frogs can level six piqued gymnasts.";

/** What the Mac shouts over the top when calibrating a barge-in. */
const DEFAULT_BARGE = "Stop talking right now please stop";

/** Options for `pnpm cli voicelab aec`. */
export interface AecOptions extends VoicelabConnectOptions {
  /** Capability name of the board under test: `stackchan`, `havpe`, … */
  board?: string;
  /** Override the sentence the board says. */
  sentence?: string;
  /** Seconds of quiet microphone to measure the room floor against. */
  quietSeconds?: number;
  /**
   * ALSO say something out loud, over the board's own speech, and report
   * whether the microphone carried it.
   *
   * This is step two: the canceller must remove the assistant's voice AND
   * leave the customer's. Passing this measures both halves of the same
   * recording — the residual in the words the board said, and the level of
   * the words the Mac said on top of them.
   */
  barge?: string;
  /** Ms into the answer at which the Mac starts talking over it. */
  bargeAtMs?: number;
  /** Dial x.ai instead of the fake. Only for the last step. */
  real?: boolean;
  /** Name the captun tunnel instead of taking a generated one. */
  tunnelName?: string;
  /** Mirror the fake provider's log to stderr. */
  verbose?: boolean;
  /** Where the WAVs land. Defaults to a per-run directory under the OS tmpdir. */
  out?: string;
  /**
   * Skip the transcript even when whisper is installed.
   *
   * NOT `noTranscribe`. Commander gives `--no-<name>` its own meaning — it
   * becomes the negation of a `--<name>` flag and lands under a different key
   * — so a flag spelled that way silently never arrives, and the transcript
   * half of this measurement quietly did not run for three sessions.
   */
  levelsOnly?: boolean;
  /** Repeat the whole measurement this many times. */
  turns?: number;
  /**
   * Speaker volumes to run the whole measurement at, loudest first.
   *
   * THE ONE CALIBRATION KNOB THAT NEEDS NO REFLASH, and the one that moves the
   * number that matters. The customer's voice arrives at the microphone at a
   * level the speaker has no say in; the echo residual arrives at a level that
   * is a function of it. So every dB off the speaker is a dB of margin for an
   * interruption, and somewhere on this sweep is the loudest setting at which
   * a person can still be heard over the assistant.
   */
  volumes?: string;
  /**
   * HAVPE only: which tap of the XMOS pipeline the uplink is taken from.
   *
   * 0 none, 1 aec, 2 ic, 3 ns, 4 agc — a RUNTIME knob (`aec.setStage`), so a
   * sweep of the whole pipeline costs no reflash. This is the one place on
   * that board where the canceller itself can be interrogated rather than its
   * compensation: if stage 1 cancels and stage 3 does not, the fault is
   * downstream of the AEC; if nothing cancels, the AEC is not being fed.
   */
  stages?: string;
  /**
   * What the Mac asks OUT LOUD to open a real turn, so the answer is long
   * enough to interrupt.
   *
   * The fake provider speaks an eleven-second pangram, so a barge fired two
   * and a half seconds in lands squarely inside it. A real provider given an
   * empty committed buffer says "Hello there, I'm Eve" and is finished before
   * the Mac starts, which produced two runs of immaculate-looking barge-in
   * numbers measured against silence. Asking for something long out loud
   * fixes that and costs nothing else — it also means the request itself goes
   * in through the board's microphone, so a turn that never starts is a real
   * finding about the uplink rather than a harness quirk.
   */
  ask?: string;
}

/** Long enough to interrupt, boring enough that a wrong answer is obvious. */
const DEFAULT_ASK = "Please count slowly from one to forty, one number per second.";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One microphone frame, kept as it arrived plus when it arrived. */
interface MicFrame {
  at: number;
  pcm: Buffer;
}

/**
 * RMS of a PCM16 run, in dBFS.
 *
 * RMS rather than peak because the question is how much ENERGY the far end is
 * being handed: a canceller that leaves one loud click and silence either side
 * is not the failure mode that matters, and peak cannot tell it from a
 * canceller leaking continuously. -120 stands in for digital silence so a
 * window of exact zeroes has a number rather than an Infinity.
 */
function rmsDbfs(pcm: Buffer): number {
  if (pcm.length < 2) return -120;
  let sum = 0;
  const samples = Math.floor(pcm.length / 2);
  for (let index = 0; index < samples; index++) {
    const sample = pcm.readInt16LE(index * 2);
    sum += sample * sample;
  }
  const rms = Math.sqrt(sum / samples);
  return rms <= 0 ? -120 : 20 * Math.log10(rms / 32768);
}

/**
 * The loudest 200 ms in the window, in dBFS.
 *
 * The companion to {@link rmsDbfs} and the one that catches intermittent
 * leakage: an answer whose canceller re-converges after every pause leaves a
 * residual only at the onsets, which averages away to nothing over eight
 * seconds and is exactly what a listener hears.
 */
function loudestSliceDbfs(pcm: Buffer): number {
  const slice = SAMPLE_RATE * 2 * 0.2;
  if (pcm.length <= slice) return rmsDbfs(pcm);
  let loudest = -120;
  for (let start = 0; start + slice <= pcm.length; start += slice / 2) {
    const level = rmsDbfs(pcm.subarray(start, start + slice));
    if (level > loudest) loudest = level;
  }
  return loudest;
}

/** A 16 kHz mono PCM16 WAV, so the evidence can be listened to. */
function writeWav(file: string, pcm: Buffer): void {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(file, Buffer.concat([header, pcm]));
}

/**
 * Where the whisper model lives, or null if nobody has fetched one.
 *
 * Checked rather than required: the level measurement is the calibration and
 * it must not be blocked by a missing 140 MB download. A run without a model
 * says so and reports the dB.
 */
function whisperModel(): string | null {
  const fromEnv = process.env.ITERATE_WHISPER_MODEL;
  if (fromEnv !== undefined && fs.existsSync(fromEnv)) return fromEnv;
  /* Walk up from THIS file rather than from the working directory: the CLI is
   * run from apps/os, from the repo root and from a Doppler wrapper, and a
   * relative path that is right for one of those is wrong for the others. */
  let dir = path.dirname(new URL(import.meta.url).pathname);
  for (let up = 0; up < 8; up++) {
    const candidate = path.join(dir, "apps/kit/firmware/tools/models/ggml-base.en.bin");
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  return null;
}

/**
 * What a transcriber makes of a recording — empty string for "nothing".
 *
 * Whisper's own no-speech markers (`[BLANK_AUDIO]`, `(silence)`, and friends)
 * are stripped rather than reported, because the whole question this answers
 * is whether there were WORDS: a run that printed "[BLANK_AUDIO]" as the
 * transcript would read as a failure at a glance and is the pass.
 */
function transcribe(file: string, model: string): string {
  let stdout: string;
  try {
    stdout = execFileSync(
      "whisper-cli",
      ["-m", model, "-f", file, "--no-timestamps", "--language", "en", "--no-prints"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch {
    return "";
  }
  return stdout
    .replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * How much of the sentence a transcript found.
 *
 * Word overlap rather than string distance: whisper transcribing "quick brown
 * fox" out of a recording that should be silent is a total failure whether or
 * not it also got the punctuation, and a single content word is already the
 * answer.
 */
function overlapWords(transcript: string, sentence: string): string[] {
  const said = new Set(
    sentence
      .toLowerCase()
      .replace(/[^a-z\s]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 3),
  );
  const heard = transcript
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((word) => said.has(word));
  return [...new Set(heard)];
}

/** The board's capability surface, as this driver uses it. */
interface BoardCapability {
  health(): Promise<Record<string, unknown>>;
  conversation: { start(): Promise<unknown>; end(): Promise<unknown> };
  speaker: { setVolume(options: { percent: number }): Promise<unknown> };
  aec: { setStage(options: { channel: number; stage: number }): Promise<unknown> };
}

/**
 * Read the board's health, RE-RESOLVING the capability on every attempt.
 *
 * A board that adopts a conversation unmounts and remounts its capabilities,
 * and the handle resolved before that is not the handle that comes back — it
 * keeps failing "no capability" for as long as it is retried, which reads
 * exactly like an unplugged device. The retry has to go back to `clients.get`,
 * not to the stub it returned.
 */
/**
 * Any call on the board, retried across a remount.
 *
 * EVERY call needs this, not just `health`. A board whose capability host has
 * gone away for its usual minute fails `conversation.start()` exactly as
 * readily, and a run that patiently retried the health probe and then fell over
 * on the next line got no further than one that had not retried at all.
 */
async function onBoard<Result>(
  itx: unknown,
  name: string,
  call: (board: BoardCapability) => Promise<Result>,
): Promise<Result> {
  let last: unknown;
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      return await call(deviceCapability<BoardCapability>(itx, name));
    } catch (error) {
      last = error;
      if (attempt === 5) console.log(`  (waiting for ${name} to remount its capabilities…)`);
      await sleep(1_000);
    }
  }
  throw new Error(`the board stopped answering: ${String(last)}`);
}

async function boardHealth(itx: unknown, name: string): Promise<Record<string, unknown>> {
  let last: unknown;
  /*
   * TWO MINUTES, because that is what was MEASURED. Ending a call takes the
   * board's capability host away and it comes back on its own — polled once a
   * second across a run that had just hung up, `no capability` for 40-60 s and
   * then a health payload with uptime running unbroken through the gap, so
   * nothing rebooted and nothing was wrong. A twenty-second budget turned that
   * recovery into "the board stopped answering", which is how a second run in
   * a row came to look like dead hardware.
   */
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      return await deviceCapability<BoardCapability>(itx, name).health();
    } catch (error) {
      last = error;
      if (attempt === 5) console.log(`  (waiting for ${name} to remount its capabilities…)`);
      await sleep(1_000);
    }
  }
  throw new Error(`the board stopped answering health(): ${String(last)}`);
}

/** Everything one measured window says about itself. */
interface Window {
  label: string;
  pcm: Buffer;
  rms: number;
  peak: number;
  seconds: number;
  /**
   * Speaker frames that arrived inside this window.
   *
   * THE ONE THING THAT CAN INVALIDATE THE WHOLE MEASUREMENT. A "quiet" window
   * that happens to contain the tail of a greeting is not a room floor, it is
   * a second echo window, and every dB of ERLE derived from it is wrong in the
   * flattering direction. Counted rather than assumed so a run can say it.
   */
  spkFrames: number;
  /** RMS per half second, so a window's SHAPE is visible and not just its mean. */
  trace: number[];
}

function measure(
  label: string,
  frames: MicFrame[],
  spkAt: number[],
  from: number,
  to: number,
): Window {
  const pcm = Buffer.concat(
    frames.filter((frame) => frame.at >= from && frame.at < to).map((frame) => frame.pcm),
  );
  const step = SAMPLE_RATE; /* half a second of PCM16 bytes */
  const trace: number[] = [];
  for (let start = 0; start + step <= pcm.length; start += step) {
    trace.push(rmsDbfs(pcm.subarray(start, start + step)));
  }
  return {
    label,
    pcm,
    rms: rmsDbfs(pcm),
    peak: loudestSliceDbfs(pcm),
    seconds: pcm.length / (SAMPLE_RATE * 2),
    spkFrames: spkAt.filter((at) => at >= from && at < to).length,
    trace,
  };
}

/**
 * The same measurement with one span cut out of the middle.
 *
 * Used for echo-only inside an answer somebody talked over: the alternative is
 * two windows either side of the interruption, and a canceller's residual is
 * not the same before and after a double-talk it had to re-converge from — so
 * a single window with a hole in it is the honest one.
 */
function measureExcluding(
  label: string,
  frames: MicFrame[],
  spkAt: number[],
  from: number,
  to: number,
  holeFrom: number,
  holeTo: number,
): Window {
  const kept = frames.filter((frame) => frame.at < holeFrom || frame.at >= holeTo);
  return measure(label, kept, spkAt, from, to);
}

/** Say it through the Mac's speaker, and do not let a missing one end the run. */
function sayOutLoud(words: string): void {
  try {
    execFileSync("say", ["-r", "170", words], { stdio: "ignore" });
  } catch {
    /* no speaker is not a reason to abandon the level measurement */
  }
}

/** The half-second trace as something readable in a terminal. */
function traceBar(trace: number[]): string {
  const glyphs = " ▁▂▃▄▅▆▇█";
  return trace
    .map((level) => {
      const scaled = Math.round(((level + 70) / 70) * (glyphs.length - 1));
      return glyphs[Math.max(0, Math.min(glyphs.length - 1, scaled))];
    })
    .join("");
}

/** The guest worker's setup surface. */
interface VoiceAgentSetup {
  health(): Promise<{ ok: true; projectId: string }>;
  setupVoiceAgent(options: {
    streamPath: string;
    providerBaseUrl?: string;
  }): Promise<{ streamPath: string; warm: { ok: boolean; ms: number } }>;
}

export async function aec(options: AecOptions) {
  const sentence = options.sentence ?? DEFAULT_SENTENCE;
  const quietSeconds = options.quietSeconds ?? 6;
  const turns = Math.max(1, options.turns ?? 1);
  /** `--barge` with no words still means "barge", so an empty string is a yes. */
  const bargeWords = options.barge === undefined ? null : options.barge || DEFAULT_BARGE;
  const boardName = options.board ?? "stackchan";
  const outDir =
    options.out ??
    path.join(process.env.TMPDIR ?? "/tmp", `iterate-aec-${boardName}-${Date.now().toString(36)}`);
  fs.mkdirSync(outDir, { recursive: true });

  const fake =
    options.real === true
      ? null
      : await startFakeGrok({
          ...(options.tunnelName === undefined ? {} : { name: options.tunnelName }),
          ...(options.verbose === undefined ? {} : { verbose: options.verbose }),
        });
  /*
   * `speech` is what makes this measurable at all — the tone the fake sends by
   * default is cancelled by a filter that would fail on speech, and a
   * transcriber has nothing to say about a sine wave. `base64Audio=1` because
   * the facet ignores binary provider frames.
   *
   * `burst=0` — PACED — because every window in this harness is timed from
   * when a speaker frame reaches the harness, and a burst provider delivers
   * eleven seconds of answer in about one. The harness clock then runs ten
   * seconds ahead of the room: the echo window closes while the board is
   * still talking, and the Mac's interruption is fired against a moment in
   * the stream rather than a moment in the air. Measured, that put 220 ms of
   * answer under a two-and-a-half-second interruption, and it is audible from
   * across the room as an interruption arriving after the assistant has
   * finished. Paced delivery makes arrival and playout the same clock, which
   * is the only way these windows mean what they are labelled.
   */
  const providerBaseUrl =
    fake === null
      ? undefined
      : `${fake.url}/v1/realtime?base64Audio=1&burst=0&answerDelayMs=150` +
        `&speech=${encodeURIComponent(sentence)}`;

  const micFrames: MicFrame[] = [];
  const spkAt: number[] = [];
  /** When a spk-frame carried `drop`: the boundary between two answers. */
  const dropSeenAt: number[] = [];
  /** Provider events with arrival times, for the self-interruption check. */
  const providerEvents: { at: number; kind: string }[] = [];
  let lastSpkAt = 0;
  let sawLast = false;

  try {
    using itx = await connectProject(options);
    const health = await boardHealth(itx, boardName);
    const streamPath = String(health.conversation);
    console.log(`aec calibration on ${boardName} (${streamPath})`);
    console.log(`  provider  ${providerBaseUrl ?? "x.ai (the real one)"}`);
    console.log(`  evidence  ${outDir}\n`);

    const install = await installVoiceAgent(itx);
    console.log(
      `  guest ${install.changed ? "installed" : "current"} (${install.commitOid.slice(0, 8)})`,
    );

    using voiceAgent = itx.workers.get(
      voiceAgentEntrypointRef,
    ) as unknown as DynamicWorkerCapability<VoiceAgentSetup>;
    for (let attempt = 0; ; attempt++) {
      try {
        await withRpcResult(voiceAgent.health(), ({ projectId }) => projectId);
        break;
      } catch (error) {
        if (attempt >= 30) throw error;
        await sleep(1_000);
      }
    }
    await withRpcResult(
      voiceAgent.setupVoiceAgent({
        ...(providerBaseUrl === undefined ? {} : { providerBaseUrl }),
        streamPath,
      }),
      ({ warm }) => warm.ms,
    );

    const stream = itx.streams.get(streamPath);
    const connection = await stream.openConnection({
      connectionKey: `aec-${Date.now().toString(36)}`,
      eventTypes: [MIC_FRAME, SPK_FRAME, GROK_EVENT],
      processEventBatch: (batch: { events?: { type: string; payload?: unknown }[] }) => {
        const at = Date.now();
        for (const event of batch.events ?? []) {
          const payload = (event.payload ?? {}) as Record<string, unknown>;
          if (event.type === MIC_FRAME) {
            const bytes = Buffer.from(String(payload.pcm ?? ""), "base64");
            micFrames.push({ at, pcm: payload.enc === "u" ? mulawToPcm16(bytes) : bytes });
            continue;
          }
          if (event.type === SPK_FRAME) {
            lastSpkAt = at;
            spkAt.push(at);
            if (payload.last === true) sawLast = true;
            /*
             * THE MOMENT THE OLD ANSWER DIED, AS SEEN ON THE WIRE.
             *
             * Everything after a `drop` is a DIFFERENT answer — the provider
             * replying to the interruption. Measuring "when did audio stop"
             * across that boundary counts the reply as the old answer running
             * on, which would make a working barge-in read as a nine-second
             * failure. The reply is the thing you WANT.
             */
            if (payload.drop === true) dropSeenAt.push(at);
          }
          /*
           * WHEN THE PROVIDER THINKS SOMEBODY STARTED TALKING.
           *
           * This is the only direct witness to double talk. Every level and
           * transcript here says what the microphone carried; this says what
           * x.ai DECIDED about it, and the failure being chased is one where
           * it decides the device interrupted itself and cancels the answer it
           * is halfway through generating. A `speech_started` between the
           * answer's first frame and the moment the Mac actually speaks has
           * exactly one explanation, and it is the one that matters.
           */
          if (event.type === GROK_EVENT) {
            const nested = payload.event as Record<string, unknown> | undefined;
            const kind = String(payload.type ?? nested?.type ?? "");
            if (kind !== "") providerEvents.push({ at, kind });
          }
        }
      },
    });

    try {
      const token = crypto.randomUUID();
      const committed = await stream.append({ payload: { token }, type: WARMUP });
      await stream.waitForEvent({
        afterOffset: (committed.at(0)?.offset ?? 1) - 1,
        eventTypes: [
          "events.iterate.com/voice-agent/warmup-ready",
          "events.iterate.com/voice-agent/warmup-unresolved",
        ],
        timeoutMs: 90_000,
      });

      /*
       * OPEN THE CALL AND LEAVE IT OPEN. Both boards this measures are
       * open-mic (`turns = SERVER_VAD`), so `talking` follows the call and the
       * microphone streams for the whole run — which is the only reason a
       * quiet window is measurable at all. On a push-to-talk board the mic
       * closes between turns and there is nothing to compare against.
       */
      await onBoard(itx, boardName, (board) => board.conversation.start());
      const openedAt = Date.now();
      let live = false;
      while (Date.now() - openedAt < 90_000) {
        if ((await boardHealth(itx, boardName)).callActive === true) {
          live = true;
          break;
        }
        await sleep(500);
      }
      if (!live) throw new Error("the board's call never went active");
      console.log(`  call live in ${String(Date.now() - openedAt)}ms\n`);

      /* Let any greeting finish before the first quiet window: an assistant
       * still saying hello is not a quiet room. */
      const greetingBy = Date.now() + 30_000;
      while (Date.now() < greetingBy) {
        await sleep(500);
        if (lastSpkAt !== 0 && Date.now() - lastSpkAt > 2_500) break;
        if (lastSpkAt === 0 && Date.now() - openedAt > 10_000) break;
      }

      const model = options.levelsOnly === true ? null : whisperModel();
      if (model === null) console.log(`  (no whisper model — levels only)\n`);

      /*
       * The sweep is the outer loop and `turns` the inner one, so a volume is
       * set once and measured `turns` times — the alternative interleaves
       * volume changes with measurements and makes every reading the first one
       * after a change the amplifier has not settled from.
       */
      const volumes = (options.volumes ?? "")
        .split(",")
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isFinite(value) && value > 0 && value <= 100);
      const margins: { volume: number | null; overEcho: number; echoPeak: number }[] = [];
      /*
       * `.filter(Boolean)` BEFORE `Number`, because `Number("")` is 0 and 0 is
       * a valid stage — the raw microphone. Without it, every run that did not
       * pass `--stages` moved the uplink OFF the flashed tap and onto the
       * unprocessed mic, then reported the result as if it were the shipped
       * configuration. A `--real` run measured that way read -0.9 dB of
       * cancellation and looked like a catastrophe; it was measuring a tap
       * nothing was asked for.
       */
      const stages = (options.stages ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
        .map(Number)
        .filter((value) => Number.isInteger(value) && value >= 0 && value <= 4);

      for (const stage of stages.length === 0 ? [null] : stages) {
        if (stage !== null) {
          await onBoard(itx, boardName, (board) => board.aec.setStage({ channel: 0, stage }));
          await sleep(2_000);
        }
        /*
         * SAY WHERE THE TAP ACTUALLY IS, EVERY RUN, FROM THE BOARD.
         *
         * `aec.setStage` outlives the run that called it — it is RAM on a
         * board that does not reboot between runs — so a sweep leaves the
         * uplink wherever its last stage put it, and the next run inherits
         * that silently. One run left the board on the raw microphone and the
         * three runs after it were read as the shipped configuration. The
         * board is the only thing that knows, so ask it rather than echoing
         * back the flag.
         */
        const tapped = (await boardHealth(itx, boardName)).aecUplinkStage;
        console.log(
          `  uplink tapped at XMOS stage ${String(tapped)}` +
            (tapped === 0 ? "  ← THE RAW MICROPHONE: nothing below is about cancellation" : ""),
        );
        for (const volume of volumes.length === 0 ? [null] : volumes) {
          if (volume !== null) {
            await onBoard(itx, boardName, (board) => board.speaker.setVolume({ percent: volume }));
            console.log(`  volume ${String(volume)}`);
            /* Let the amplifier and the canceller settle at the new level: the
             * filter has been adapting to the old one and its first seconds at a
             * new one are its worst. */
            await sleep(2_000);
          }
          for (let turn = 1; turn <= turns; turn++) {
            /*
             * THE QUIET WINDOW COMES FIRST, EVERY TURN.
             *
             * Not once at the top: the room changes, the Mac's fan spins up, and
             * a floor measured four minutes ago turns a quiet room into a 12 dB
             * ERLE. Both halves of the comparison have to come from the same
             * minute or the comparison is not one.
             */
            const before = await boardHealth(itx, boardName);
            /*
             * WAIT FOR THE PREVIOUS ANSWER TO ACTUALLY STOP COMING OUT OF THE
             * SPEAKER. The device holds up to the server's lead, so the wire going
             * quiet is not the room going quiet, and a floor measured over the tail
             * of the last turn reads 20 dB high — which is exactly what the volume
             * 70 row of the first sweep did, and it made that row's leak figure
             * unusable while looking like a result.
             */
            const settleBy = Date.now() + 20_000;
            while (Date.now() < settleBy && lastSpkAt !== 0 && Date.now() - lastSpkAt < 6_000) {
              await sleep(250);
            }
            const quietFrom = Date.now();
            await sleep(quietSeconds * 1_000);
            const quiet = measure("quiet", micFrames, spkAt, quietFrom, Date.now());

            /*
             * WHAT AN INTERRUPTION LOOKS LIKE WITH NOTHING IN ITS WAY.
             *
             * The control the whole barge-in calibration turns on. "The echo
             * residual is -41 dBFS" is not a verdict about anything until there is
             * a number for the customer's own voice through the same microphone at
             * the same distance — the question is never how quiet the echo is, it
             * is how far the voice sits ABOVE it. Measured with the speaker idle so
             * this one is the ceiling, and the double-talk window below is how much
             * of that ceiling survives.
             */
            let voice: Window | null = null;
            if (bargeWords !== null) {
              const voiceFrom = Date.now();
              console.log(`    saying it into a quiet room: ${JSON.stringify(bargeWords)}`);
              sayOutLoud(bargeWords);
              await sleep(1_200); /* the capture queue holds the tail */
              voice = measure("voice", micFrames, spkAt, voiceFrom, Date.now());
            }

            /* Ask for the sentence. Both boards are open-mic, so the turn is
             * bounded from the stream — one append so the release cannot overtake
             * the press. */
            sawLast = false;
            lastSpkAt = 0;
            const askedAt = Date.now();
            await discardRpcResult(
              stream.append(
                { ephemeral: true, payload: { t: askedAt }, type: PTT_START },
                { ephemeral: true, payload: { t: askedAt }, type: PTT_END },
              ),
            );
            /*
             * ...AND WITH A REAL PROVIDER, ASK IT FOR SOMETHING LONG, OUT LOUD.
             *
             * The press above commits an empty buffer, which x.ai answers with
             * a three-second greeting — shorter than the delay before the Mac
             * interrupts, so the interruption lands in silence. The fake needs
             * none of this because its sentence is eleven seconds by
             * construction.
             */
            let askDoneAt = 0;
            if (options.real === true) {
              const ask = options.ask ?? DEFAULT_ASK;
              console.log(`    asking out loud: ${JSON.stringify(ask)}`);
              sayOutLoud(ask);
              askDoneAt = Date.now();
            }

            /* Wait for the first speaker frame — everything before it is still
             * quiet room and would dilute the echo window it was averaged into. */
            while (lastSpkAt === 0 && Date.now() - askedAt < 30_000) await sleep(50);
            if (lastSpkAt === 0) throw new Error("the provider never sent a speaker frame");
            /*
             * THE ECHO WINDOW CANNOT START WHILE THE QUESTION IS STILL ARRIVING.
             *
             * With a real provider the Mac asks out loud, and the capture queue
             * hands those frames over about a second late — so the first second
             * of the "echo" recording is the Mac, not the board. Measured: a
             * window that should have contained the assistant counting
             * transcribed as "from 1 to 40, 1 number per second", which is the
             * question. The answer's first frame usually lands after the
             * question has finished, but not always and never by enough.
             */
            const echoFrom = Math.max(lastSpkAt, askDoneAt === 0 ? 0 : askDoneAt + 1_200);

            let bargeSaid = false;
            const bargeAt = echoFrom + (options.bargeAtMs ?? 2_500);
            /**
             * When the Mac started and stopped talking over the answer.
             *
             * The double-talk window is bounded by THIS, not by the answer: an
             * interruption is two seconds long inside an eleven-second answer, and
             * averaging it across the whole answer buries the only part being
             * measured under nine seconds of echo-only.
             */
            let doubleFrom = 0;
            let doubleTo = 0;
            /** The board's echo peaks with only the assistant in the room. */
            let echoOnlyHealth: Record<string, unknown> | null = null;

            /* The board is still playing for as long as frames keep arriving, plus
             * the lead the server holds — so "playing" ends when the stream goes
             * quiet AND the device has had time to drain what it holds. */
            const deadline = Date.now() + 180_000;
            while (Date.now() < deadline) {
              await sleep(100);
              if (bargeWords !== null && !bargeSaid && Date.now() >= bargeAt) {
                bargeSaid = true;
                echoOnlyHealth = await boardHealth(itx, boardName);
                console.log(`    saying over it: ${JSON.stringify(bargeWords)}`);
                doubleFrom = Date.now();
                sayOutLoud(bargeWords);
                doubleTo = Date.now() + 800; /* the capture queue's own lag */
              }
              if (sawLast && Date.now() - lastSpkAt > 1_500) break;
              if (!sawLast && lastSpkAt !== 0 && Date.now() - lastSpkAt > 8_000) break;
            }
            /* The device holds up to the server's lead; give it the room. */
            /* The device holds up to the server's lead, so the last words leave the
             * speaker AFTER the last frame lands; a window that stopped at the wire
             * would miss the tail, which is where a re-converging canceller leaks. */
            await sleep(4_000);
            const echoTo = Date.now();
            /*
             * ECHO-ONLY EXCLUDES THE INTERRUPTION, which is the whole reason the
             * two are separate windows: an echo residual measured across the
             * seconds somebody was shouting is a measurement of the shouting.
             */
            const echo =
              doubleFrom === 0
                ? measure("echo", micFrames, spkAt, echoFrom, echoTo)
                : measureExcluding(
                    "echo",
                    micFrames,
                    spkAt,
                    echoFrom,
                    echoTo,
                    doubleFrom,
                    doubleTo,
                  );
            const double =
              doubleFrom === 0 ? null : measure("double", micFrames, spkAt, doubleFrom, doubleTo);

            const stem = path.join(
              outDir,
              volume === null
                ? `turn-${String(turn)}`
                : `vol${String(volume)}-turn-${String(turn)}`,
            );
            writeWav(`${stem}-quiet.wav`, quiet.pcm);
            writeWav(`${stem}-echo.wav`, echo.pcm);
            if (voice !== null) writeWav(`${stem}-voice.wav`, voice.pcm);
            if (double !== null) writeWav(`${stem}-double.wav`, double.pcm);

            /*
             * WHAT THE CANCELLER ITSELF SAYS IT DID TO THE SIGNAL.
             *
             * `aecReferenceClipped` is the saturating digital gain on the board's
             * analogue reference hitting the rail. A clipped reference is a LIE
             * about what the speaker emitted, and an adaptive filter fed one cannot
             * converge however long it is given — which is the shape the traces
             * above have at high volume and do not have at low. Reading it per
             * answer is what separates "the echo is too loud" from "the canceller
             * was told the wrong thing about it", and those have opposite fixes.
             */
            const after = await boardHealth(itx, boardName);
            const clipped = {
              reference:
                Number(after.aecReferenceClipped ?? 0) - Number(before.aecReferenceClipped ?? 0),
              uplink: Number(after.aecUplinkClipped ?? 0) - Number(before.aecUplinkClipped ?? 0),
              recreates: Number(after.aecRecreates ?? 0) - Number(before.aecRecreates ?? 0),
            };

            /*
             * THE BOARD'S OWN ORACLE, WHERE IT HAS ONE.
             *
             * HAVPE carries both taps of its XMOS canceller — the raw capture
             * and the cancelled one, measured while the speaker was running —
             * so it can state its own echo return loss without anybody
             * inferring it from a room recording. Everything else here measures
             * what LEFT the board; this measures what the canceller did inside
             * it, and the two disagreeing would be the interesting result.
             *
             * `echoFramesMuted` sits beside them because it is the other way an
             * uplink can be quiet: not cancelled but REFUSED. A board that
             * declines to send during playback looks identical to a perfect
             * canceller in every level here, and is the opposite of one for an
             * interruption.
             */
            /*
             * READ BEFORE THE MAC OPENS ITS MOUTH, NOT AFTER.
             *
             * `echoRawPeak`/`echoCleanPeak` are high-water marks accumulated
             * for as long as the speaker is running, and the interruption
             * happens while the speaker is running. A person's voice is not
             * echo and the canceller is right not to remove it, so it lands on
             * BOTH peaks and drags the ratio to zero — a turn where the barge
             * overlapped well reported "-0.4 dB of cancellation" and read as a
             * canceller that had collapsed. The echo-only read is taken at the
             * instant the barge fires; the post-turn one is kept only as the
             * fallback for turns that never barged.
             */
            const oracle = echoOnlyHealth ?? after;
            const rawPeak = Number(oracle.echoRawPeak ?? 0);
            const cleanPeak = Number(oracle.echoCleanPeak ?? 0);
            const oracleDb =
              rawPeak > 0 && cleanPeak > 0 ? 20 * Math.log10(cleanPeak / rawPeak) : null;
            const muted = Number(after.echoFramesMuted ?? 0) - Number(before.echoFramesMuted ?? 0);

            const erle = echo.rms - quiet.rms;
            const erlePeak = echo.peak - quiet.peak;
            console.log(`  turn ${String(turn)}`);
            for (const window of [quiet, voice, echo, double].filter((w) => w !== null)) {
              console.log(
                `    ${window.label.padEnd(6)}  ${window.rms.toFixed(1).padStart(6)} dBFS rms  ` +
                  `${window.peak.toFixed(1).padStart(6)} dBFS peak200  (${window.seconds.toFixed(1)}s)  ` +
                  `|${traceBar(window.trace)}|`,
              );
            }
            if (quiet.spkFrames > 0) {
              console.log(
                `    ! the quiet window contained ${String(quiet.spkFrames)} speaker frames — ` +
                  `it is not a room floor and the leak figure below is meaningless`,
              );
            }
            console.log(
              `    LEAK    ${erle >= 0 ? "+" : ""}${erle.toFixed(1)} dB rms  ${erlePeak >= 0 ? "+" : ""}${erlePeak.toFixed(1)} dB peak  above the quiet room`,
            );
            console.log(
              `    CLIP    reference ${String(clipped.reference)}  uplink ${String(clipped.uplink)}` +
                (clipped.recreates > 0
                  ? `  (the engine was rebuilt ${String(clipped.recreates)}×)`
                  : "") +
                (clipped.reference > 0
                  ? `  ← the canceller's copy of the far end hit the rail`
                  : ""),
            );
            if (oracleDb !== null || muted > 0) {
              console.log(
                `    ORACLE  ` +
                  (oracleDb === null
                    ? ""
                    : `the board says raw ${String(rawPeak)} → clean ${String(cleanPeak)} (${oracleDb.toFixed(1)} dB of cancellation)  `) +
                  (muted > 0
                    ? `and REFUSED ${String(muted)} frames as echo ← a refused uplink cannot carry an interruption either`
                    : `and refused no frames`),
              );
            }
            /*
             * THE BARGE-IN MARGIN, which is the number that says whether a person
             * has to shout. Everything above is about the echo; this is about
             * whether anything of the customer gets through on top of it. Peak
             * rather than rms on both sides: a voice activity detector fires on the
             * loud part of a syllable, not on the average of a sentence.
             */
            /*
             * WAS THE ANSWER STILL PLAYING WHILE THE MAC SHOUTED?
             *
             * If it was not, none of the double-talk numbers below are about
             * double talk. The barge is fired a fixed delay after the answer's
             * FIRST speaker frame, which is right for an eleven-second fake
             * sentence and wrong for a real provider's three-second greeting:
             * the answer is over before the Mac opens its mouth, and the turn
             * then reports a beautifully clean interruption that nothing was
             * competing with. Reported first, in frames, because it decides
             * whether anything after it counts — Jonas heard this from across
             * the room ("it doesn't really overlap that much") while the
             * harness was calling those turns a pass.
             */
            /*
             * DID THE ANSWER SURVIVE ITSELF?
             *
             * The double-talk failure does not look like echo in a recording,
             * it looks like an assistant that stops after two words. So the
             * answer's own length and the provider's own speech decisions are
             * reported for EVERY turn, including turns nobody interrupted —
             * those are the pure ones, because the only voice in the room was
             * the board's and any `speech_started` at all is the device
             * hearing itself.
             */
            {
              const answerMs = lastSpkAt - echoFrom;
              const selfHeard = providerEvents.filter(
                (candidate) =>
                  candidate.kind.includes("speech_started") &&
                  candidate.at > echoFrom &&
                  (doubleFrom === 0 || candidate.at < doubleFrom),
              );
              console.log(
                `    ANSWER  ran ${String(answerMs)}ms and ${sawLast ? "finished" : "STOPPED WITHOUT FINISHING"}` +
                  (selfHeard.length === 0
                    ? "  ✓ the provider never thought it was being interrupted"
                    : `  ✗ SELF-INTERRUPTED: ${String(selfHeard.length)} speech_started with nobody in the room talking`),
              );
            }
            if (double !== null) {
              const overlapMs = double.spkFrames * 20;
              console.log(
                double.spkFrames === 0
                  ? `    OVERLAP none — the answer had already finished, so this turn says NOTHING about double talk`
                  : `    OVERLAP ${String(overlapMs)}ms of answer under the interruption (${String(double.spkFrames)} speaker frames)`,
              );
            }
            if (double !== null && voice !== null) {
              const overEcho = double.peak - echo.peak;
              margins.push({ volume, overEcho, echoPeak: echo.peak });
              /*
               * DID IT ACTUALLY STOP TALKING?
               *
               * Every other number here is about whether the customer's voice
               * reaches the far end. This is the only one about what the far end
               * DID with it, and against a real provider it is the whole point:
               * the answer's last speaker frame lands within a second or so of
               * somebody interrupting, or nobody heard them. Printed only with a
               * real provider — the fake has no detector and cancels nothing, so
               * it would always read "not cancelled" and mean nothing.
               */
              if (options.real === true) {
                const ranOnMs = lastSpkAt - doubleFrom;
                const killedAt = dropSeenAt.filter((at) => at >= doubleFrom)[0];
                console.log(
                  killedAt === undefined
                    ? `    KILLED  no drop reached the wire — the old answer was never superseded`
                    : `    KILLED  the old answer was dropped ${String(killedAt - doubleFrom)}ms after the interruption began` +
                        `  (audio after this is the REPLY, not the run-on)`,
                );
                /*
                 * ALL AUDIO, OF EITHER ANSWER — KILLED above is the line that
                 * says whether barge-in worked. This one counts the provider's
                 * REPLY to the interruption as well, and a reply is the desired
                 * outcome, so on its own it condemns a working system: it read
                 * five seconds while KILLED read two and a half, and four fixes
                 * were aimed at that difference before anyone noticed the
                 * difference was Grok answering the question.
                 */
                console.log(
                  `    AUDIO   the last frame of ANY answer landed ${String(Math.max(0, ranOnMs))}ms after the interruption` +
                    (killedAt === undefined
                      ? ``
                      : `, of which ${String(Math.max(0, lastSpkAt - killedAt))}ms was the reply`),
                );
                /*
                 * WHICH HALF FAILED, because "not cancelled" has two causes
                 * with opposite fixes.
                 *
                 * Either the provider never noticed — the uplink did not carry
                 * the interruption in a form its detector fires on, and the
                 * work is on this device — or it noticed and the answer kept
                 * coming anyway, which is ours: a `speech_started` that
                 * nothing acts on means the barge-in flush never ran. The
                 * transcript can say the words were there and still not
                 * distinguish these, because whisper is not the detector.
                 */
                const noticed = providerEvents.filter(
                  (candidate) =>
                    candidate.kind.includes("speech_started") && candidate.at >= doubleFrom,
                );
                console.log(
                  noticed.length === 0
                    ? `    DETECT  the provider never reported speech during the interruption ← it did not hear it`
                    : `    DETECT  ${String(noticed[0].at - doubleFrom)}ms after the interruption started` +
                        `  (DELIVERY, not detection: this lane is coalesced)`,
                );
                /*
                 * THE PROVIDER'S OWN ACCOUNT OF THE INTERRUPTION, IN ORDER.
                 *
                 * Two fixes for the run-on were reasoned out, shipped and
                 * measured — dropping the held queue, then asking x.ai to
                 * cancel the response — and neither moved STOP by a
                 * millisecond. That is a sign of arguing from a model of the
                 * conversation rather than from the conversation. Every
                 * provider event in the window is printed with its offset so
                 * the next change is made against a transcript: whether
                 * `response.cancel` was answered, whether deltas kept coming
                 * after it, and whether the events arrive spread out or in one
                 * coalesced clump (which would mean these offsets are the
                 * lane's and not x.ai's).
                 */
                /*
                 * WHEN THE ROOM WENT QUIET, WHICH IS THE ONLY THING A PERSON
                 * EXPERIENCES.
                 *
                 * STOP is the last speaker frame to reach THIS PROCESS, and
                 * the lane it reaches it on is ephemeral and coalesced — the
                 * provider's own events arrived in a single clump two and a
                 * half seconds late, so the same lag is in STOP. Three fixes
                 * were measured against it and not one moved it, which is
                 * what a wrong clock looks like.
                 *
                 * The board's microphone is in the room. After the Mac stops
                 * talking, anything still loud is the board still talking, and
                 * the last frame above the room floor is the moment it
                 * stopped. That number owes nothing to any lane.
                 */
                /*
                 * NO ARRIVAL TIMES. Microphone frames are 20 ms and
                 * continuous, so position in the sequence IS time, and that is
                 * the one clock this harness has that the coalescing lane
                 * cannot bend. Four fixes in a row were measured against
                 * arrival-time clocks and not one of them moved a number,
                 * which is what measuring the transport instead of the room
                 * looks like.
                 *
                 * Find the loudest frame in the interruption — the Mac at its
                 * peak, unambiguous — and count forward to the last frame
                 * still above the room floor. What is loud after the Mac has
                 * finished is the board, and how long it stays loud is how
                 * long it kept talking.
                 */
                const floor = quiet.rms + 6;
                const loud = micFrames.map((frame) => rmsDbfs(frame.pcm));
                let peakIndex = -1;
                for (let index = 0; index < micFrames.length; index++) {
                  if (
                    micFrames[index].at >= doubleFrom &&
                    micFrames[index].at <= doubleTo &&
                    (peakIndex === -1 || loud[index] > loud[peakIndex])
                  ) {
                    peakIndex = index;
                  }
                }
                let lastLoud = peakIndex;
                for (let index = peakIndex; index >= 0 && index < loud.length; index++) {
                  if (loud[index] > floor) lastLoud = index;
                }
                console.log(
                  peakIndex === -1
                    ? `    QUIET   no interruption found in the microphone to measure from`
                    : `    QUIET   the room went quiet ${String((lastLoud - peakIndex) * 20)}ms after the interruption peaked` +
                        `  (${String(lastLoud - peakIndex)} frames, no arrival times)`,
                );
                /*
                 * DID THE INSTRUCTION ARRIVE LATE, OR DID THE RING EMPTY SLOWLY?
                 *
                 * Two causes, opposite fixes, and every clock in this process
                 * hides the difference because they all measure arrival on the
                 * coalescing lane. The board stamps its OWN uptime when it
                 * obeys a drop, and `health()` comes back over RPC carrying
                 * both that stamp and the uptime now — so the difference is
                 * "how long ago the board was told", measured entirely on the
                 * board. Subtracting it from the age of the interruption gives
                 * when it was told, relative to the Mac opening its mouth.
                 */
                const drops = Number(after.spkDrops ?? 0) - Number(before.spkDrops ?? 0);
                const stamp = Number(after.spkLastDropUptimeMs ?? 0);
                const upNow = Number(after.uptimeMs ?? 0);
                console.log(
                  drops === 0
                    ? `    TOLD    the board was never told to drop ← the instruction did not arrive at all`
                    : `    TOLD    the board obeyed ${String(drops)} drop(s), the last ${String(upNow - stamp)}ms before this health read` +
                        `, i.e. ~${String(Math.round(doubleFrom + (Date.now() - doubleFrom) - (upNow - stamp) - doubleFrom))}ms after the interruption began`,
                );
                const window = providerEvents.filter(
                  (candidate) =>
                    candidate.at >= doubleFrom - 500 && candidate.at <= lastSpkAt + 500,
                );
                console.log(
                  `    EVENTS  ${
                    window.length === 0
                      ? "(none)"
                      : window
                          .map((e) => `${String(e.at - doubleFrom)}ms ${e.kind}`)
                          .join("  ")
                          .slice(0, 400)
                  }`,
                );
              }
              const cost = double.peak - voice.peak;
              console.log(
                `    BARGE   voice alone ${voice.peak.toFixed(1)} → over the answer ${double.peak.toFixed(1)} dBFS peak200 ` +
                  `(${cost >= 0 ? "+" : ""}${cost.toFixed(1)} dB of it survived)`,
              );
              /*
               * A LEVEL RATIO, AND ONLY THAT — the verdict is the transcript
               * below.
               *
               * This line used to call anything under +6 dB "BURIED: a
               * detector cannot separate this from the echo", which was true
               * of a linear tap where loudness was the only thing telling
               * speech from residue. It is false of a levelled one: at the AGC
               * tap a person and the residue arrive within a decibel of each
               * other and whisper still transcribes the person verbatim and
               * the residue as nothing, because they differ in structure and
               * not in size. Two runs in a row printed BURIED directly above
               * "✓ the interruption survived the answer", and the scary line
               * is the one a person believes.
               */
              console.log(
                `            it stands ${overEcho >= 0 ? "+" : ""}${overEcho.toFixed(1)} dB above the echo residual` +
                  (overEcho < 6
                    ? "  (level alone will not separate them — see the transcript)"
                    : ""),
              );
            }

            if (model !== null) {
              const quietText = transcribe(`${stem}-quiet.wav`, model);
              const echoText = transcribe(`${stem}-echo.wav`, model);
              const leaked = overlapWords(echoText, sentence);
              console.log(`    mic during quiet:    ${quietText === "" ? "(nothing)" : quietText}`);
              console.log(`    mic during playback: ${echoText === "" ? "(nothing)" : echoText}`);
              /*
               * Only the fake provider says a sentence known in advance, so
               * only there can a word-overlap check mean anything. Against
               * x.ai this compared the recording with a pangram nobody spoke
               * and printed a tick every time. The real double-talk verdict
               * for those runs is the ANSWER line, which asks the provider.
               */
              if (options.real === true) {
                console.log(
                  `    (no leak check: the provider chose its own words — see ANSWER for the verdict)`,
                );
              } else if (leaked.length > 0) {
                console.log(`    ✗ THE MICROPHONE HEARD THE ASSISTANT: ${leaked.join(", ")}`);
              } else {
                console.log(`    ✓ no word of the sentence survived into the microphone`);
              }
              /*
               * THE INTERRUPTION IS IN THE DOUBLE-TALK WINDOW, NOT THE ECHO ONE,
               * and reading it out of the echo transcript made this line a
               * tautology: the echo window has the interruption's own seconds cut
               * out of it, so the words could not have been there whatever the
               * canceller did, and the answer was always "did NOT survive".
               *
               * The voice-alone window is printed beside it because it is the
               * control that decides what that means. Words there and none in
               * double-talk is a canceller suppressing the customer. NOTHING IN
               * EITHER is not a barge-in finding at all — it is an uplink that
               * cannot carry speech, and no threshold anywhere will fix it.
               */
              if (voice !== null && double !== null) {
                const voiceText = transcribe(`${stem}-voice.wav`, model);
                const doubleText = transcribe(`${stem}-double.wav`, model);
                console.log(
                  `    mic, voice alone:    ${voiceText === "" ? "(nothing)" : voiceText}`,
                );
                console.log(
                  `    mic, voice over it:  ${doubleText === "" ? "(nothing)" : doubleText}`,
                );
                const aloneHeard = overlapWords(voiceText, bargeWords ?? "");
                const overHeard = overlapWords(doubleText, bargeWords ?? "");
                if (aloneHeard.length === 0) {
                  console.log(
                    `    ! the uplink could not carry the interruption even in SILENCE — ` +
                      `this is not a barge-in problem, it is a microphone one`,
                  );
                } else if (overHeard.length === 0) {
                  console.log(
                    `    ✗ the interruption was lost UNDER the answer (clear when alone)`,
                  );
                } else {
                  console.log(
                    `    ✓ the interruption survived the answer: ${overHeard.join(", ")}`,
                  );
                }
              }
            }
            console.log("");
          }
        }
      }
      if (margins.length > 0 && volumes.length > 1) {
        console.log(`  the sweep, as one table`);
        console.log(`    volume   echo peak   voice stands`);
        for (const entry of margins) {
          console.log(
            `    ${String(entry.volume ?? "-").padStart(6)}   ${entry.echoPeak.toFixed(1).padStart(9)}   ` +
              `${(entry.overEcho >= 0 ? "+" : "") + entry.overEcho.toFixed(1)} dB above it`,
          );
        }
        /* Loudest first in the sweep, so the first entry clearing the bar is
         * the loudest setting a person can still interrupt from. */
        const usable = margins.find((entry) => entry.overEcho >= 12);
        console.log(
          usable === undefined
            ? `\n    NO VOLUME ON THIS SWEEP GIVES AN INTERRUPTION ROOM — the residual ` +
                `follows the speaker down, so this is not a level problem to be turned away`
            : `\n    loudest setting an interruption survives: volume ${String(usable.volume)}`,
        );
        console.log("");
      }
    } finally {
      await connection.close?.();
      await onBoard(itx, boardName, (board) => board.conversation.end()).catch(() => undefined);
    }
  } finally {
    await fake?.close();
  }
  console.log(`evidence in ${outDir}`);
}
