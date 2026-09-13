// GPT-Live, straight from this Mac: the wire protocol under pressure, with no
// iterate infrastructure in the path.
//
//   doppler run --config dev -- pnpm cli voicelab live-probe
//   doppler run --config dev -- pnpm cli voicelab live-probe --gap-seconds 12 --say2 "…"
//   doppler run --config dev -- pnpm cli voicelab live-probe --barge-after-ms 4000 --say2 "…"
//   doppler run --config dev -- pnpm cli voicelab live-probe --mute --say2 "…"
// WHY THIS EXISTS. It measures the GPT-Live wire under pressure: whether
// output arrives at playout pace or in bursts, whether a gap in input stalls
// the session timeline, delegation latency, and whether muting silences the
// transcript. Each experiment is a flag here, each prints what the wire said,
// and the summary is JSON.
import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import WebSocket from "ws";

import { FRAME_BYTES, FRAME_MS, sleep, synthesizeFrames } from "./probe-audio.ts";

/** Options for `pnpm cli voicelab live-probe`. */
export interface LiveProbeOptions {
  /** The first utterance, synthesized with macOS `say`. */
  say?: string;
  /** A second utterance: after --gap-seconds of silence, as a barge, or muted. */
  say2?: string;
  /** Send NO audio at all for this long between the two utterances. */
  gapSeconds?: number;
  /** Speak --say2 once this much answer audio has arrived (an interruption). */
  bargeAfterMs?: number;
  /** Mute input, speak --say2, unmute — the transcript must stay silent. */
  mute?: boolean;
  /** A hold-to-unmute release: stop sending ANY frames for this long the moment --say ends. */
  stopAfterUtteranceMs?: number;
  /** Speak --say2 this long after the FIRST delegation is created (a second
   * request while the backend is still working). */
  say2AfterDelegationMs?: number;
  /** Microphone audio per `session.input_audio.append`, in ms (default 100):
   * does the provider's output cadence suffer when input arrives in large
   * appends? */
  micAppendMs?: number;
  /** Feed the model's own output audio back into its input, delayed this
   * many ms at half amplitude — a perfect acoustic echo with no echo
   * cancellation anywhere. Does the model hear itself as the person? */
  echoBackMs?: number;
  /** Live audio format rate: 16000 (the pipeline's) or 24000. */
  rate?: number;
  /** Frontend instructions; a delegation-policy prompt when omitted. */
  instructions?: string;
  /** What the probe says back for a client delegation. */
  commentary?: string;
  /** How long after the delegation the commentary is appended. */
  commentaryDelayMs?: number;
  /** Write every received output sample to this WAV file. */
  saveWav?: string;
  /** Give up after this many seconds. */
  seconds?: number;
  /** Silence to wait after the last answer before closing. */
  settleMs?: number;
  /** Print every non-audio wire event as it arrives. */
  verbose?: boolean;
}

const SILENCE_FRAME = Buffer.alloc(FRAME_BYTES);
/** An answer is a run of SPEAKING output deltas with no silence this long inside it. */
const ANSWER_GAP_MS = 1_200;
/** A delta whose loudest sample is under this is silence (idle deltas are exact zero). */
const SPEECH_PEAK = 300;
const DEFAULT_INSTRUCTIONS = [
  "You are Iterate, a calm voice assistant on a small speaker. Speak briefly and naturally.",
  "Backchannel policy: Use moderate backchannels.",
  "Interruption policy: Stop speaking when the user interrupts. Listen to what they say.",
  "Delegation policy:",
  "Backend tools:",
  "- The iterate project: read its files and repo, run scripts, look things up, do work.",
  "Delegate to the backend when:",
  "- The request needs the project, a lookup, or careful reasoning.",
  "Do not delegate to the backend when:",
  "- You can answer from the conversation, or need a brief clarification.",
  "Delegate before giving an answer that depends on backend work. Do not guess the result while waiting.",
].join("\n");

interface TranscriptFragment {
  speaker: "user" | "assistant";
  text: string;
  startMs: number;
  endMs: number;
  /** Probe clock, ms since session.started. */
  arrivedAtMs: number;
}

interface AnswerStats {
  firstAudioAtMs: number;
  lastAudioAtMs: number;
  audioMs: number;
  deltas: number;
}

interface DelegationRecord {
  id: string;
  offsetMs: number;
  createdAtMs: number;
  /** Utterance-end to delegation, when an utterance preceded it. */
  afterUtteranceEndMs: number | null;
  commentaryAppendedAtMs: number | null;
  /** Commentary append → first SPEAKING output delta. */
  spokenAfterCommentaryMs: number | null;
  /** Commentary append → first assistant transcript fragment. */
  transcriptAfterCommentaryMs: number | null;
  /** First speaking delta and first assistant transcript after this delegation. */
  firstSpeechAfterMs: number | null;
  firstTranscriptAfterMs: number | null;
}

export async function liveProbe(options: LiveProbeOptions = {}): Promise<void> {
  const apiKey =
    process.env.OPENAI_API_KEY?.trim() ?? process.env.APP_CONFIG_OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY is required (run inside doppler run --config dev).");
  const rate = options.rate ?? 16_000;
  if (rate !== 16_000 && rate !== 24_000) throw new Error("--rate must be 16000 or 24000");
  const say =
    options.say ||
    "Hi there. Can you check what files are in my project's config repo, and tell me how many there are?";
  const deadlineMs = (options.seconds ?? 120) * 1_000;
  const settleMs = options.settleMs ?? 6_000;
  const verbose = options.verbose ?? true;

  const dir = mkdtempSync(path.join(tmpdir(), "live-probe-"));
  const utterance1 = synthesizeFrames(dir, "say1", say).map((b64) => Buffer.from(b64, "base64"));
  const utterance2 = !options.say2
    ? null
    : synthesizeFrames(dir, "say2", options.say2).map((b64) => Buffer.from(b64, "base64"));
  rmSync(dir, { recursive: true, force: true });

  const startedAtWall = Date.now();
  const clock = () => Date.now() - startedAtWall;
  const log = (line: string) => {
    if (verbose) console.error(`  [${String(clock()).padStart(6)}ms] ${line}`);
  };

  const fragments: TranscriptFragment[] = [];
  const answers: AnswerStats[] = [];
  const delegations = new Map<string, DelegationRecord>();
  const errors: unknown[] = [];
  const outputChunks: Buffer[] = [];
  let sessionId: string | null = null;
  let sessionStartedAtMs: number | null = null;
  let closedReason: string | null = null;
  let usageSeconds: number | null = null;
  let contextRatio: number | null = null;
  let lastSpeechAtMs: number | null = null;
  let lastUtteranceEndAtMs: number | null = null;
  let muted = false;
  let mutedAckAtMs: number | null = null;
  let unmutedAckAtMs: number | null = null;
  let transcriptWhileMuted = 0;
  let bargeSpokenAtMs: number | null = null;
  let secondRequestSpoken = false;
  let outputAfterBargeMs: number | null = null;
  let outputStoppedAfterBargeMs: number | null = null;

  const socket = new WebSocket("wss://api.openai.com/v1/live/sessions", {
    headers: { Authorization: `Bearer ${apiKey}`, "User-Agent": "iterate-voicelab/live-probe" },
  });
  const send = (event: Record<string, unknown>) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(event));
    if (event.type !== "session.input_audio.append") {
      log(`→ ${String(event.type)}${event.event_id ? ` (${String(event.event_id)})` : ""}`);
    }
  };

  const sessionConfig: Record<string, unknown> = {
    model: "gpt-live-1",
    instructions: options.instructions || DEFAULT_INSTRUCTIONS,
    audio: {
      format: { type: "audio/pcm", rate },
      output: { voice: "marin" },
    },
    delegation: { type: "client" },
  };

  socket.on("open", () => {
    log(`socket open; sending session.start (client delegation, ${rate} Hz)`);
    send({ type: "session.start", event_id: "start_1", session: sessionConfig });
  });
  socket.on("error", (error) => {
    errors.push(String(error));
    log(`socket error: ${String(error)}`);
  });
  socket.on("unexpected-response", (_request, response) => {
    let body = "";
    response.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    response.on("end", () => {
      errors.push(`upgrade refused: HTTP ${String(response.statusCode)} ${body.slice(0, 500)}`);
      log(`upgrade refused: HTTP ${String(response.statusCode)} ${body.slice(0, 500)}`);
    });
  });

  let finished: (() => void) | null = null;
  const done = new Promise<void>((resolve) => {
    finished = resolve;
  });
  socket.on("close", (code, reason) => {
    log(`socket closed ${String(code)} ${reason.toString("utf8")}`);
    finished?.();
  });

  /*
   * THE OUTPUT IS A CONTINUOUS STREAM — measured: 873 deltas in 87 s, one per
   * 100 ms, silence included (740 of them exact digital zero). So an "answer"
   * is a run of SPEAKING deltas, and the raw provider cadence is realtime.
   */
  let outputDeltas = 0;
  let silentDeltas = 0;
  let zeroDeltas = 0;
  /** Probe clock at every output delta, for the arrival cadence. */
  const deltaArrivalsMs: number[] = [];
  let echoedBytes = 0;
  const noteAnswerAudio = (pcm: Buffer) => {
    deltaArrivalsMs.push(clock());
    if (options.echoBackMs !== undefined && pcm.length > 0) {
      /* Half amplitude: a speaker heard by its own microphone. */
      const echo = Buffer.alloc(pcm.length);
      for (let index = 0; index + 1 < pcm.length; index += 2) {
        echo.writeInt16LE(Math.trunc(pcm.readInt16LE(index) / 2), index);
      }
      setTimeout(() => {
        if (socket.readyState !== WebSocket.OPEN) return;
        echoedBytes += echo.length;
        socket.send(
          JSON.stringify({ type: "session.input_audio.append", audio: echo.toString("base64") }),
        );
      }, options.echoBackMs);
    }
    const now = clock();
    const bytes = pcm.length;
    outputDeltas += 1;
    const peak = peakOf(pcm);
    if (peak === 0) zeroDeltas += 1;
    if (peak < SPEECH_PEAK) {
      silentDeltas += 1;
      return;
    }
    lastSpeechAtMs = now;
    for (const record of delegations.values()) {
      if (record.firstSpeechAfterMs === null && now > record.createdAtMs) {
        record.firstSpeechAfterMs = now - record.createdAtMs;
      }
    }
    const audioMs = bytes / ((rate * 2) / 1000);
    const current = answers.at(-1);
    if (current && now - current.lastAudioAtMs < ANSWER_GAP_MS) {
      current.lastAudioAtMs = now;
      current.audioMs += audioMs;
      current.deltas += 1;
    } else {
      answers.push({ firstAudioAtMs: now, lastAudioAtMs: now, audioMs, deltas: 1 });
      const sinceUtterance = lastUtteranceEndAtMs === null ? null : now - lastUtteranceEndAtMs;
      log(
        `← first audio of answer #${String(answers.length)}` +
          (sinceUtterance === null
            ? ""
            : ` — ${String(sinceUtterance)}ms after the utterance ended`),
      );
      for (const record of delegations.values()) {
        if (record.commentaryAppendedAtMs !== null && record.spokenAfterCommentaryMs === null) {
          record.spokenAfterCommentaryMs = now - record.commentaryAppendedAtMs;
        }
      }
    }
    if (bargeSpokenAtMs !== null && outputStoppedAfterBargeMs === null) {
      outputAfterBargeMs = now - bargeSpokenAtMs;
    }
  };

  socket.on("message", (data) => {
    const text =
      typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : "";
    /* Wire frames are JSON objects; the assertion names the record shape and
     * the switch below checks `type` and every field it reads. */
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(text) as Record<string, unknown>;
    } catch {
      errors.push(`unparseable frame: ${text.slice(0, 120)}`);
      return;
    }
    const type = String(event.type ?? "");
    switch (type) {
      case "session.started": {
        /* Per the provider's SessionStartedEvent schema; only `id` is read. */
        const session = event.session as { id?: string; audio?: unknown; delegation?: unknown };
        sessionId = session.id || null;
        sessionStartedAtMs = clock();
        log(
          `← session.started ${String(sessionId)} audio=${JSON.stringify(session.audio)} delegation=${JSON.stringify(session.delegation).slice(0, 200)}`,
        );
        return;
      }
      case "session.output_audio.delta": {
        const delta = typeof event.delta === "string" ? event.delta : "";
        const bytes = Buffer.from(delta, "base64");
        outputChunks.push(bytes);
        noteAnswerAudio(bytes);
        return;
      }
      case "session.input_transcript.delta":
      case "session.output_transcript.delta": {
        const fragment: TranscriptFragment = {
          speaker: type === "session.input_transcript.delta" ? "user" : "assistant",
          text: String(event.delta ?? ""),
          startMs: Number(event.start_ms ?? 0),
          endMs: Number(event.end_ms ?? 0),
          arrivedAtMs: clock(),
        };
        fragments.push(fragment);
        if (muted && fragment.speaker === "user") transcriptWhileMuted += 1;
        if (fragment.speaker === "assistant") {
          for (const record of delegations.values()) {
            if (
              record.commentaryAppendedAtMs !== null &&
              record.transcriptAfterCommentaryMs === null
            ) {
              record.transcriptAfterCommentaryMs =
                fragment.arrivedAtMs - record.commentaryAppendedAtMs;
            }
          }
        }
        log(
          `← ${fragment.speaker} transcript [${String(fragment.startMs)}–${String(fragment.endMs)}] ${JSON.stringify(fragment.text)}`,
        );
        return;
      }
      case "session.delegation.created": {
        /* Per the provider's DelegationCreatedEvent schema. */
        const info = event.delegation as { id: string; target: string };
        if (info.target !== "client") {
          errors.push(`unexpected delegation target: ${info.target}`);
          return;
        }
        const now = clock();
        const record: DelegationRecord = {
          id: info.id,
          offsetMs: Number(event.offset_ms ?? 0),
          createdAtMs: now,
          afterUtteranceEndMs: lastUtteranceEndAtMs === null ? null : now - lastUtteranceEndAtMs,
          commentaryAppendedAtMs: null,
          spokenAfterCommentaryMs: null,
          transcriptAfterCommentaryMs: null,
          firstSpeechAfterMs: null,
          firstTranscriptAfterMs: null,
        };
        delegations.set(info.id, record);
        if (options.say2AfterDelegationMs !== undefined && utterance2 && !secondRequestSpoken) {
          secondRequestSpoken = true;
          void (async () => {
            await sleep(options.say2AfterDelegationMs!);
            if (socket.readyState !== WebSocket.OPEN) return;
            await speak(utterance2, "the SECOND request, while the backend works");
          })();
        }
        log(
          `← session.delegation.created ${info.id} target=${info.target} offset=${String(record.offsetMs)}ms` +
            (record.afterUtteranceEndMs === null
              ? ""
              : ` — ${String(record.afterUtteranceEndMs)}ms after the utterance ended`),
        );
        void answerClientDelegation(record);
        return;
      }
      case "session.input_audio.muted":
        mutedAckAtMs = clock();
        log(`← session.input_audio.muted`);
        return;
      case "session.input_audio.unmuted":
        unmutedAckAtMs = clock();
        log(`← session.input_audio.unmuted`);
        return;
      case "session.usage.updated": {
        /* Per the provider's SessionUsageUpdatedEvent schema; both optional. */
        const usage = event.usage as { seconds?: number } | undefined;
        const window = event.context_window as { usage_ratio?: number } | undefined;
        usageSeconds = usage?.seconds ?? usageSeconds;
        contextRatio = window?.usage_ratio ?? contextRatio;
        log(`← usage ${String(usageSeconds)}s context=${String(contextRatio)}`);
        return;
      }
      case "session.closed": {
        /* Per the provider's SessionClosedEvent schema. */
        const usage = event.usage as { seconds?: number } | undefined;
        usageSeconds = usage?.seconds ?? usageSeconds;
        closedReason = String(event.reason ?? "");
        log(`← session.closed reason=${closedReason} usage=${String(usageSeconds)}s`);
        socket.close();
        return;
      }
      case "error": {
        errors.push(event.error);
        log(`← ERROR ${JSON.stringify(event.error)}`);
        return;
      }
      default:
        log(`← ${type} ${JSON.stringify(event).slice(0, 300)}`);
    }
  });

  /* The probe supplies a fixed client delegation response so it can measure
   * the Live side's commentary-to-speech latency independently. */
  async function answerClientDelegation(record: DelegationRecord) {
    send({
      type: "session.thinking.append",
      event_id: `thinking_${record.id}`,
      delegation_id: record.id,
      content: "Backend: looking at the project's config repo now. Nothing found yet.",
    });
    await sleep(options.commentaryDelayMs ?? 3_000);
    if (socket.readyState !== WebSocket.OPEN) return;
    record.commentaryAppendedAtMs = clock();
    send({
      type: "session.commentary.append",
      event_id: `commentary_${record.id}`,
      delegation_id: record.id,
      content:
        options.commentary ||
        "Backend result: the config repo has four files — package.json, worker.ts, voice-agent.ts and AGENTS.md. Nothing else.",
    });
  }

  /* -------------------------------------------------------------- the mic */

  /*
   * ONE REAL-TIME-PACED LOOP, silence when there is nothing to say — an open
   * microphone in a quiet room. `speak()` splices an utterance in without
   * breaking the cadence; `gapSeconds` stops the loop dead on purpose, to
   * see whether the timeline survives NO frames at all.
   */
  let pending: Buffer[] = [];
  let micRunning = true;
  let micPaused = false;
  const speak = (frames: Buffer[], label: string) =>
    new Promise<void>((resolve) => {
      log(`speaking ${label} (${String(frames.length * FRAME_MS)}ms of audio)`);
      pending = pending.concat(frames);
      const marker = Buffer.alloc(0);
      pending.push(marker);
      const check = setInterval(() => {
        if (!pending.includes(marker)) {
          clearInterval(check);
          lastUtteranceEndAtMs = clock();
          log(`finished sending ${label}`);
          resolve();
        }
      }, 20);
    });
  const micLoop = (async () => {
    const framesPerSend = Math.max(1, Math.round((options.micAppendMs ?? 100) / FRAME_MS));
    let sequence = 0;
    const startedAt = Date.now();
    while (micRunning) {
      const due = startedAt + (sequence + framesPerSend) * FRAME_MS;
      const wait = due - Date.now();
      if (wait > 0) await sleep(wait);
      sequence += framesPerSend;
      if (micPaused || socket.readyState !== WebSocket.OPEN) continue;
      const chunk: Buffer[] = [];
      for (let index = 0; index < framesPerSend; index++) {
        let frame = pending.shift();
        while (frame && frame.length === 0) frame = pending.shift();
        chunk.push(frame || SILENCE_FRAME);
      }
      const pcm16 = Buffer.concat(chunk);
      const audio = rate === 16_000 ? pcm16 : upsample16kTo24k(pcm16);
      socket.send(
        JSON.stringify({ type: "session.input_audio.append", audio: audio.toString("base64") }),
      );
    }
  })();

  const waitFor = async (predicate: () => boolean, timeoutMs: number) => {
    const until = Date.now() + timeoutMs;
    while (!predicate() && Date.now() < until) await sleep(50);
    return predicate();
  };
  const answerSettled = () => lastSpeechAtMs !== null && clock() - lastSpeechAtMs > settleMs;

  /* -------------------------------------------------------------- script */

  const scenario = (async () => {
    if (!(await waitFor(() => sessionStartedAtMs !== null, 15_000))) {
      errors.push("session.started never arrived");
      return;
    }
    await sleep(1_000);
    if (options.stopAfterUtteranceMs !== undefined) {
      /* Pause microphone frames the instant the words end. */
      const speaking = speak(utterance1, "utterance 1");
      await waitFor(() => pending.length === 0, 30_000);
      micPaused = true;
      log(`mic stopped dead for ${String(options.stopAfterUtteranceMs)}ms`);
      await speaking;
      await sleep(options.stopAfterUtteranceMs);
      micPaused = false;
      log(`mic resumed`);
    } else {
      await speak(utterance1, "utterance 1");
    }
    const answersBefore = answers.length;
    const answered = await waitFor(() => answers.length > answersBefore, 45_000);
    if (!answered) errors.push("no answer audio within 45s of utterance 1");

    if (options.bargeAfterMs !== undefined && utterance2) {
      const enough = await waitFor(
        () => (answers.at(-1)?.audioMs ?? 0) >= options.bargeAfterMs!,
        30_000,
      );
      if (!enough)
        errors.push(`answer shorter than the ${String(options.bargeAfterMs)}ms barge point`);
      bargeSpokenAtMs = clock();
      const speaking = speak(utterance2, "the interruption");
      /* Did the voice stop, and how long after the interruption began? */
      await waitFor(() => lastSpeechAtMs !== null && clock() - lastSpeechAtMs > 600, 30_000);
      outputStoppedAfterBargeMs =
        // oxlint-disable-next-line iterate/simple-truthiness-check -- zero is a valid probe timestamp.
        lastSpeechAtMs === null ? null : Math.max(0, lastSpeechAtMs - bargeSpokenAtMs);
      log(`voice went quiet ${String(outputStoppedAfterBargeMs)}ms after the interruption began`);
      await speaking;
      await waitFor(() => answers.length > answersBefore + 1, 30_000);
      await waitFor(() => answerSettled(), 30_000);
    } else if (options.gapSeconds !== undefined && utterance2) {
      await waitFor(() => answerSettled(), 60_000);
      log(`stopping the mic entirely for ${String(options.gapSeconds)}s`);
      micPaused = true;
      await sleep(options.gapSeconds * 1_000);
      micPaused = false;
      log(`mic resumed`);
      await sleep(500);
      const before = answers.length;
      await speak(utterance2, "utterance 2 (after the gap)");
      if (!(await waitFor(() => answers.length > before, 45_000))) {
        errors.push("no answer within 45s of utterance 2 after the input gap");
      }
    } else if (options.mute === true && utterance2) {
      await waitFor(() => answerSettled(), 60_000);
      const fragmentsBefore = fragments.filter((f) => f.speaker === "user").length;
      send({ type: "session.input_audio.mute", event_id: "mute_1" });
      await waitFor(() => mutedAckAtMs !== null, 5_000);
      muted = true;
      await speak(utterance2, "utterance 2 (MUTED — should be ignored)");
      await sleep(6_000);
      muted = false;
      send({ type: "session.input_audio.unmute", event_id: "unmute_1" });
      await waitFor(() => unmutedAckAtMs !== null, 5_000);
      const heardWhileMuted =
        fragments.filter((f) => f.speaker === "user").length - fragmentsBefore;
      log(`user transcript fragments while muted: ${String(heardWhileMuted)}`);
      await sleep(500);
      const before = answers.length;
      await speak(utterance2, "utterance 2 again (unmuted)");
      if (!(await waitFor(() => answers.length > before, 45_000))) {
        errors.push("no answer within 45s of utterance 2 after unmute");
      }
    } else if (utterance2 && options.say2AfterDelegationMs !== undefined) {
      /* The second request is spoken from the delegation arm; just give the
       * whole exchange time to play out. */
      await waitFor(() => delegations.size >= 2, 60_000);
    } else if (utterance2) {
      await waitFor(() => answerSettled(), 60_000);
      const before = answers.length;
      await speak(utterance2, "utterance 2");
      if (!(await waitFor(() => answers.length > before, 45_000))) {
        errors.push("no answer within 45s of utterance 2");
      }
    }

    /* Let each fixed client response become speech, then wait for quiet. */
    await waitFor(
      () => [...delegations.values()].every((d) => d.spokenAfterCommentaryMs !== null),
      deadlineMs,
    );
    await waitFor(() => answerSettled(), 120_000);
  })();

  await Promise.race([scenario, sleep(deadlineMs)]);
  micRunning = false;
  await micLoop;
  if (socket.readyState === WebSocket.OPEN) {
    send({ type: "session.close", event_id: "close_1" });
    await Promise.race([done, sleep(15_000)]);
    if (socket.readyState === WebSocket.OPEN) {
      errors.push("session.closed never arrived within 15s of session.close");
      socket.terminate();
    }
  }

  if (options.saveWav) {
    writeFileSync(options.saveWav, wav(Buffer.concat(outputChunks), rate));
    log(`wrote ${options.saveWav}`);
  }

  /* ------------------------------------------------------------- verdict */

  const turns = groupTurns(fragments);
  const summary = {
    sessionId,
    startedMs: sessionStartedAtMs,
    delegation: "client",
    rate,
    output: {
      deltas: outputDeltas,
      /* Inter-arrival gaps between consecutive 100 ms deltas: the jitter the
       * provider itself puts on the wire, before any platform hop. */
      arrivalGapsMs: gapStats(deltaArrivalsMs),
      echoedBackMs: options.echoBackMs === undefined ? null : echoedBytes / ((rate * 2) / 1000),
      silentDeltas,
      zeroDeltas,
      speechMs: Math.round(answers.reduce((total, answer) => total + answer.audioMs, 0)),
    },
    answers: answers.map((answer) => ({
      firstAudioAtMs: answer.firstAudioAtMs,
      audioMs: Math.round(answer.audioMs),
      deltas: answer.deltas,
      wallMs: answer.lastAudioAtMs - answer.firstAudioAtMs,
      /* audio-ms per wall-ms of arrival: ≈1 means the model hands audio over
       * at the pace it plays; ≫1 is a burst. */
      cadence:
        answer.lastAudioAtMs > answer.firstAudioAtMs
          ? Number((answer.audioMs / (answer.lastAudioAtMs - answer.firstAudioAtMs)).toFixed(2))
          : null,
    })),
    transcript: turns,
    delegations: [...delegations.values()].map((d) => ({
      id: d.id,
      offsetMs: d.offsetMs,
      afterUtteranceEndMs: d.afterUtteranceEndMs,
      spokenAfterCommentaryMs: d.spokenAfterCommentaryMs,
      transcriptAfterCommentaryMs: d.transcriptAfterCommentaryMs,
      createdAtMs: d.createdAtMs,
      firstSpeechAfterMs: d.firstSpeechAfterMs,
      firstTranscriptAfterMs: d.firstTranscriptAfterMs,
    })),
    mute:
      options.mute === true
        ? { mutedAckAtMs, unmutedAckAtMs, userFragmentsWhileMuted: transcriptWhileMuted }
        : undefined,
    barge:
      // oxlint-disable-next-line iterate/simple-truthiness-check -- zero is a valid probe timestamp.
      bargeSpokenAtMs === null
        ? undefined
        : {
            bargeSpokenAtMs,
            outputStoppedAfterBargeMs,
            lastOutputAfterBargeMs: outputAfterBargeMs,
          },
    usageSeconds,
    contextRatio,
    closedReason,
    errors,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (errors.length > 0) process.exitCode = 1;
}

/* ================================================================ helpers */

/** Distribution of the gaps between consecutive arrival times. */
export function gapStats(arrivalsMs: number[]): GapStats {
  const gaps: number[] = [];
  for (let index = 1; index < arrivalsMs.length; index++) {
    gaps.push(arrivalsMs[index]! - arrivalsMs[index - 1]!);
  }
  return gapStatsOfGaps(gaps);
}

/** Percentiles of a set of intervals; see gapStats. */
export interface GapStats {
  count: number;
  p50: number;
  p90: number;
  p99: number;
  max: number;
  over150: number;
  over250: number;
}

/** The same statistics over intervals the caller already computed. */
export function gapStatsOfGaps(intervals: number[]): GapStats {
  const gaps = [...intervals];
  gaps.sort((a, b) => a - b);
  const at = (q: number) =>
    gaps.length === 0 ? 0 : gaps[Math.min(gaps.length - 1, Math.floor(q * gaps.length))]!;
  return {
    count: gaps.length,
    p50: at(0.5),
    p90: at(0.9),
    p99: at(0.99),
    max: gaps.at(-1) ?? 0,
    over150: gaps.filter((gap) => gap > 150).length,
    over250: gaps.filter((gap) => gap > 250).length,
  };
}

/** The loudest sample in a PCM16 buffer, as a non-negative int. */
function peakOf(pcm: Buffer): number {
  let peak = 0;
  for (let index = 0; index + 1 < pcm.length; index += 2) {
    const value = Math.abs(pcm.readInt16LE(index));
    if (value > peak) peak = value;
  }
  return peak;
}

/** Linear 16 → 24 kHz for the probe's mic only; production uses its PCM converter. */
function upsample16kTo24k(pcm16: Buffer): Buffer {
  const samples = pcm16.length / 2;
  const outSamples = Math.floor((samples * 3) / 2);
  const out = Buffer.alloc(outSamples * 2);
  for (let index = 0; index < outSamples; index++) {
    const position = (index * 2) / 3;
    const left = Math.floor(position);
    const right = Math.min(samples - 1, left + 1);
    const frac = position - left;
    const a = pcm16.readInt16LE(left * 2);
    const b = pcm16.readInt16LE(right * 2);
    out.writeInt16LE(Math.round(a + (b - a) * frac), index * 2);
  }
  return out;
}

/** Groups transcript fragments into rows per speaker, split on a timeline gap. */
function groupTurns(fragments: TranscriptFragment[]) {
  const rows: {
    speaker: string;
    startMs: number;
    endMs: number;
    text: string;
    /** Probe clock when the row's first fragment arrived. */
    arrivedAtMs: number;
  }[] = [];
  for (const fragment of fragments) {
    const last = rows.at(-1);
    if (
      last &&
      last.speaker === fragment.speaker &&
      fragment.startMs - last.endMs < ANSWER_GAP_MS
    ) {
      last.text += fragment.text;
      last.endMs = Math.max(last.endMs, fragment.endMs);
    } else {
      rows.push({
        speaker: fragment.speaker,
        startMs: fragment.startMs,
        endMs: fragment.endMs,
        text: fragment.text,
        arrivedAtMs: fragment.arrivedAtMs,
      });
    }
  }
  return rows;
}

function wav(pcm: Buffer, rate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
