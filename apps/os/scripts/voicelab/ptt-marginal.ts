// MARGINAL overhead: with the provider ALREADY connected, how much longer
// does an answer take because our stream is in the middle?
//
// `ptt-latency` and `ptt-baseline` each answer half of this, in separate runs,
// minutes apart, against a provider whose own think time wanders by hundreds
// of milliseconds between rounds. Subtracting two such numbers measures the
// provider's mood as much as our plumbing. This runs BOTH halves in one
// process, alternating turn by turn, speaking the identical audio at identical
// pacing into a socket that is warm in both cases — so the difference between
// the two medians is ours and not the weather.
//
//   doppler run --config preview_3 -- pnpm cli voicelab ptt-marginal \
//     --project facet-proof-8 --stream-path /agents/voice/ptt-1 \
//     --mic-wav /tmp/utterance.wav --rounds 8
//
// Attribution, not just a total: each stream turn also reports where its time
// went, using the facet's own clock. Every `spk-frame` carries `t`, the
// facet's timestamp for the provider delta it was cut from, and `pong` carries
// the facet's clock against a client-measured round trip — so the two clocks
// can be aligned and the answer split into "before the facet had the audio"
// and "after", without shipping the provider's delta firehose to this process
// and perturbing the very thing being measured.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { connectProject, type VoicelabConnectOptions } from "./connect.ts";
import { closeAndDisposeRpcHandle, discardRpcResult } from "./rpc-ownership.ts";

/** Options for `pnpm cli voicelab ptt-marginal`. */
export interface PttMarginalOptions extends VoicelabConnectOptions {
  /** The stream whose facet is under test. Must already be set up. */
  streamPath?: string;
  /** How many A/B pairs to run. Medians of fewer than about six mean little. */
  rounds?: number;
  /**
   * A PCM16 mono 16 kHz WAV holding ONE utterance, a few seconds long.
   *
   * Required, and it must contain words: a tone gives the model nothing to
   * answer, and a turn the model declines to answer is not a latency.
   */
  micWav: string;
  /** Quiet after each turn, so an answer finishes before the next press. */
  settleMs?: number;
  /** Frames per append. Twelve is what the C client sends. */
  framesPerAppend?: number;
  /** Provider endpoint for the direct half. Defaults to xAI's realtime API. */
  grokBaseUrl?: string;
  model?: string;
}

const FRAME_MS = 20;
/** 20 ms of 16 kHz PCM16 = 320 samples = 640 bytes. */
const FRAME_SAMPLES = 320;
/** Clock-alignment probes per round; the median of three beats any one. */
const SKEW_PROBES = 3;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The frames of a PCM16 mono 16 kHz WAV, base64, 20 ms at a time. */
function framesFromWav(file: string): string[] {
  const bytes = fs.readFileSync(file);
  /* Find the data chunk rather than assuming a 44-byte header: a WAV written
   * by anything other than us may carry extra chunks. */
  const dataAt = bytes.indexOf("data", 12, "ascii");
  const start = dataAt === -1 ? 44 : dataAt + 8;
  const frames: string[] = [];
  for (
    let offset = start;
    offset + FRAME_SAMPLES * 2 <= bytes.length;
    offset += FRAME_SAMPLES * 2
  ) {
    frames.push(bytes.subarray(offset, offset + FRAME_SAMPLES * 2).toString("base64"));
  }
  return frames;
}

/** Median and tails. A mean hides exactly the round worth looking at. */
function summarize(values: number[]): { n: number; p50: number; p90: number; max: number } | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const at = (fraction: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]!;
  return { n: sorted.length, p50: at(0.5), p90: at(0.9), max: sorted[sorted.length - 1]! };
}

function median(values: number[]): number | null {
  const summary = summarize(values);
  return summary === null ? null : summary.p50;
}

/** What one turn cost, however it was carried. */
interface Turn {
  /** Release -> first answer audio at this process. What a person feels. */
  totalMs: number | null;
  /** Whether the provider session was already up when the press happened. */
  warm: boolean;
}

/** A stream turn, with the facet's own clock folded in. */
interface StreamTurn extends Turn {
  /**
   * Release -> the facet holding the answer's first byte, on the client clock.
   *
   * Everything upstream of us plus everything inside the provider: the
   * `ptt-end` append, the facet's commit, the model, and the delta coming
   * back to the facet.
   */
  toFacetMs: number | null;
  /** The facet holding a frame -> this process hearing it. Purely our downlink. */
  downlinkMs: number | null;
  /** Round-trip through the whole plumbing for a minimal event. */
  pingRttMs: number | null;
}

/** A direct turn, measured on the socket it was spoken into. */
interface DirectTurn extends Turn {
  /** The provider's ack of the commit -> its first audio delta. Think time. */
  providerMs: number | null;
}

/** The session shape the facet sends, so both halves ask for the same thing. */
const sessionUpdate = {
  type: "session.update",
  session: {
    type: "realtime",
    audio: {
      input: { format: { type: "audio/pcm", rate: 16_000 }, turn_detection: null },
      output: { format: { type: "audio/pcm", rate: 16_000 }, voice: "eve" },
    },
  },
};

/** One provider socket, held open across rounds exactly as the facet holds its own. */
async function dialProvider(baseUrl: string, model: string, apiKey: string) {
  const target = new URL(baseUrl);
  target.searchParams.set("model", model);
  const { WebSocket } = await import("ws");
  const socket = new WebSocket(target.toString(), {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  /** Arrival times, by provider event type, newest last. */
  const seen = new Map<string, number[]>();
  const note = (type: string) => {
    const times = seen.get(type) ?? [];
    times.push(Date.now());
    seen.set(type, times);
  };
  const ready = new Promise<void>((resolve, reject) => {
    socket.on("error", reject);
    socket.on("message", (raw: Buffer) => {
      let event: { type?: string };
      try {
        event = JSON.parse(raw.toString("utf8")) as { type?: string };
      } catch {
        return;
      }
      if (typeof event.type !== "string") return;
      note(event.type);
      if (event.type === "session.created") socket.send(JSON.stringify(sessionUpdate));
      if (event.type === "session.updated") resolve();
    });
  });
  return {
    socket,
    ready,
    /** The first arrival of `type` at or after `since`, or null. */
    firstAfter: (type: string, since: number) => seen.get(type)?.find((at) => at >= since) ?? null,
    send: (message: Record<string, unknown>) => socket.send(JSON.stringify(message)),
  };
}

export async function pttMarginal(options: PttMarginalOptions) {
  const apiKey = process.env.APP_CONFIG_X_AI_API_KEY?.trim() ?? "";
  if (apiKey === "") throw new Error("APP_CONFIG_X_AI_API_KEY is required for the direct half.");
  const streamPath = options.streamPath ?? "/agents/voice/ptt-1";
  const rounds = options.rounds ?? 8;
  const settleMs = options.settleMs ?? 8_000;
  const batch = Math.max(1, options.framesPerAppend ?? 12);
  const baseUrl = options.grokBaseUrl ?? "https://api.x.ai/v1/realtime";
  const model = options.model ?? "grok-voice-think-fast-2.0";
  const spoken = framesFromWav(options.micWav);
  console.log(
    `  ${spoken.length} frames (${((spoken.length * FRAME_MS) / 1000).toFixed(1)}s) from ` +
      `${options.micWav}, ${rounds} rounds, alternating stream and direct\n`,
  );

  using itx = await connectProject(options);
  const stream = itx.streams.get(streamPath);

  /*
   * ONLY WHAT A DEVICE SUBSCRIBES TO. The provider's verbatim `grok-event`
   * lane would give a second, independent anchor — but it carries every audio
   * delta, so subscribing to it roughly doubles the downlink this probe
   * receives and inflates the number the probe exists to measure.
   */
  let spkAt: { at: number; facetT: number }[] = [];
  const pongs = new Map<string, { at: number; facetT: number }>();
  let redialledThisTurn = false;
  const connection = await stream.openConnection({
    connectionKey: `ptt-marginal-${Date.now()}`,
    eventTypes: [
      "events.iterate.com/voice-agent/spk-frame",
      "events.iterate.com/voice-agent/pong",
      "events.iterate.com/voice-agent/call-started",
      "events.iterate.com/voice-agent/conversation-failed",
      "events.iterate.com/voice-agent/conversation-ended",
    ],
    processEventBatch: (payloadBatch: { events?: { type: string; payload?: unknown }[] }) => {
      const at = Date.now();
      for (const event of payloadBatch.events ?? []) {
        const payload = (event.payload ?? {}) as Record<string, unknown>;
        if (event.type === "events.iterate.com/voice-agent/spk-frame") {
          spkAt.push({ at, facetT: typeof payload.t === "number" ? payload.t : Number.NaN });
          continue;
        }
        if (event.type === "events.iterate.com/voice-agent/pong") {
          pongs.set(String(payload.id), {
            at,
            facetT: typeof payload.t1 === "number" ? payload.t1 : Number.NaN,
          });
          continue;
        }
        /* A call that had to be re-opened pays a handshake this run is
         * explicitly not measuring; the round is kept but marked cold. */
        redialledThisTurn = true;
      }
    },
  });

  /**
   * How far the facet's clock is ahead of ours, and what a minimal round trip
   * through the plumbing costs.
   *
   * `pong` is the smallest thing the facet can be asked to produce, so its
   * round trip is the floor for anything the facet says. Assuming the two legs
   * are symmetric, the facet's stamp should sit at the midpoint of the trip.
   */
  async function probeClock(): Promise<{ skewMs: number | null; rttMs: number | null }> {
    const skews: number[] = [];
    const rtts: number[] = [];
    for (let probe = 0; probe < SKEW_PROBES; probe++) {
      const id = `skew-${Date.now()}-${probe}`;
      const sentAt = Date.now();
      await discardRpcResult(
        stream.append({
          type: "events.iterate.com/voice-agent/ping",
          ephemeral: true,
          payload: { id },
        }),
      );
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && !pongs.has(id)) await sleep(5);
      const pong = pongs.get(id);
      if (pong === undefined || Number.isNaN(pong.facetT)) continue;
      rtts.push(pong.at - sentAt);
      skews.push(pong.facetT - (sentAt + pong.at) / 2);
    }
    return { skewMs: median(skews), rttMs: median(rtts) };
  }

  /** Speak the utterance into the stream, paced to real time, awaiting nothing. */
  async function speakToStream(pressedAt: number): Promise<number> {
    for (let index = 0; index < spoken.length; index += batch) {
      /* A batch cannot be sent before the audio in it has been captured. */
      const due = pressedAt + Math.min(index + batch, spoken.length) * FRAME_MS;
      const wait = due - Date.now();
      if (wait > 0) await sleep(wait);
      const events = [];
      for (let offset = 0; offset < batch && index + offset < spoken.length; offset++) {
        events.push({
          type: "events.iterate.com/voice-agent/mic-frame" as const,
          ephemeral: true as const,
          payload: { seq: index + offset, pcm: spoken[index + offset]! },
        });
      }
      void stream.append(...events).catch(() => undefined);
    }
    return Date.now();
  }

  async function streamTurn(skewMs: number | null, rttMs: number | null): Promise<StreamTurn> {
    spkAt = [];
    redialledThisTurn = false;
    const pressedAt = Date.now();
    await discardRpcResult(
      stream.append({
        type: "events.iterate.com/voice-agent/ptt-start",
        ephemeral: true,
        payload: { t: pressedAt },
      }),
    );
    const releasedAt = await speakToStream(pressedAt);
    await discardRpcResult(
      stream.append({
        type: "events.iterate.com/voice-agent/ptt-end",
        ephemeral: true,
        payload: { t: releasedAt },
      }),
    );

    const deadline = Date.now() + 30_000;
    let heard: { at: number; facetT: number } | undefined;
    while (Date.now() < deadline) {
      heard = spkAt.find((frame) => frame.at >= releasedAt);
      if (heard !== undefined) break;
      await sleep(5);
    }
    if (heard === undefined) {
      return { totalMs: null, toFacetMs: null, downlinkMs: null, pingRttMs: rttMs, warm: true };
    }
    /* The facet's stamp, moved onto this process's clock. */
    const facetHadItAt =
      skewMs === null || Number.isNaN(heard.facetT) ? null : heard.facetT - skewMs;
    return {
      totalMs: heard.at - releasedAt,
      toFacetMs: facetHadItAt === null ? null : Math.round(facetHadItAt - releasedAt),
      downlinkMs: facetHadItAt === null ? null : Math.round(heard.at - facetHadItAt),
      pingRttMs: rttMs,
      warm: !redialledThisTurn,
    };
  }

  async function directTurn(
    session: Awaited<ReturnType<typeof dialProvider>>,
  ): Promise<DirectTurn> {
    const pressedAt = Date.now();
    /* Paced exactly as the stream half paces it, so both put audio on the wire
     * at the same rate rather than one of them dumping it in a burst. */
    for (let index = 0; index < spoken.length; index++) {
      const due = pressedAt + index * FRAME_MS;
      const wait = due - Date.now();
      if (wait > 0) await sleep(wait);
      session.send({ type: "input_audio_buffer.append", audio: spoken[index]! });
    }
    const releasedAt = Date.now();
    session.send({ type: "input_audio_buffer.commit" });
    session.send({ type: "response.create" });

    const deadline = Date.now() + 30_000;
    let audioAt: number | null = null;
    while (Date.now() < deadline) {
      audioAt = session.firstAfter("response.output_audio.delta", releasedAt);
      if (audioAt !== null) break;
      await sleep(5);
    }
    const committedAt = session.firstAfter("input_audio_buffer.committed", releasedAt);
    return {
      totalMs: audioAt === null ? null : audioAt - releasedAt,
      providerMs: audioAt === null || committedAt === null ? null : audioAt - committedAt,
      warm: true,
    };
  }

  const direct = await dialProvider(baseUrl, model, apiKey);
  const streamTurns: StreamTurn[] = [];
  const directTurns: DirectTurn[] = [];

  try {
    await direct.ready;

    /*
     * A WARM-UP TURN THAT IS NOT MEASURED. The question is explicitly about a
     * provider that is already connected, and the facet only dials on the
     * first press — so measuring round one would measure the handshake this
     * run is trying to exclude.
     */
    console.log("  warming the facet's provider socket (unmeasured)...");
    const warm = await streamTurn(null, null);
    console.log(`  warm-up ${warm.totalMs === null ? "TIMEOUT" : `${warm.totalMs}ms`}\n`);
    await sleep(settleMs);

    for (let round = 0; round < rounds; round++) {
      const clock = await probeClock();
      const viaStream = await streamTurn(clock.skewMs, clock.rttMs);
      streamTurns.push(viaStream);
      await sleep(settleMs);

      const viaDirect = await directTurn(direct);
      directTurns.push(viaDirect);

      const show = (value: number | null, unit = "ms") =>
        value === null ? "     -" : `${String(value).padStart(4)}${unit}`;
      console.log(
        `  round ${String(round + 1).padStart(2)}  ` +
          `stream ${show(viaStream.totalMs)}  (to-facet ${show(viaStream.toFacetMs)}, ` +
          `down ${show(viaStream.downlinkMs)}, ping-rtt ${show(viaStream.pingRttMs)})  ` +
          `direct ${show(viaDirect.totalMs)}  (think ${show(viaDirect.providerMs)})` +
          `${viaStream.warm ? "" : "  [re-dialled]"}`,
      );

      if (round + 1 < rounds) await sleep(settleMs);
    }
  } finally {
    closeAndDisposeRpcHandle(connection);
    direct.socket.close();
  }

  const warmStream = streamTurns.filter((turn) => turn.warm);
  const streamTotals = warmStream.map((t) => t.totalMs).filter((v): v is number => v !== null);
  const directTotals = directTurns.map((t) => t.totalMs).filter((v): v is number => v !== null);
  const streamP50 = median(streamTotals);
  const directP50 = median(directTotals);

  const report = {
    kind: "ptt-marginal",
    streamPath,
    baseUrl,
    model,
    rounds,
    micWav: options.micWav,
    utteranceFrames: spoken.length,
    framesPerAppend: batch,
    /** Release -> first answer audio, with the provider already connected. */
    streamReleaseToAudioMs: summarize(streamTotals),
    directReleaseToAudioMs: summarize(directTotals),
    /** The headline: what the stream costs on top of talking to xAI ourselves. */
    marginalMs: streamP50 === null || directP50 === null ? null : streamP50 - directP50,
    /** Release -> the facet holding the answer's first byte. */
    toFacetMs: summarize(warmStream.map((t) => t.toFacetMs).filter((v): v is number => v !== null)),
    /** Facet holds a frame -> this process hears it. */
    downlinkMs: summarize(
      warmStream.map((t) => t.downlinkMs).filter((v): v is number => v !== null),
    ),
    /** A minimal event's round trip through the same plumbing. */
    pingRttMs: summarize(warmStream.map((t) => t.pingRttMs).filter((v): v is number => v !== null)),
    /** The model's own time, measured where nothing of ours can colour it. */
    providerThinkMs: summarize(
      directTurns.map((t) => t.providerMs).filter((v): v is number => v !== null),
    ),
    streamTurns,
    directTurns,
  };

  const runsDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../../.voicelab-runs",
  );
  fs.mkdirSync(runsDir, { recursive: true });
  const out = path.join(
    runsDir,
    `ptt-marginal-${new Date().toISOString().replace(/\D/g, "")}.json`,
  );
  fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);

  const line = (label: string, summary: ReturnType<typeof summarize>) => {
    if (summary === null) return;
    console.log(
      `  ${label.padEnd(22)} p50 ${String(summary.p50).padStart(5)}ms  ` +
        `p90 ${String(summary.p90).padStart(5)}ms  max ${String(summary.max).padStart(5)}ms  ` +
        `(n=${summary.n})`,
    );
  };
  console.log("");
  line("stream release→audio", report.streamReleaseToAudioMs);
  line("direct release→audio", report.directReleaseToAudioMs);
  line("  of which: to facet", report.toFacetMs);
  line("  of which: downlink", report.downlinkMs);
  line("ping round trip", report.pingRttMs);
  line("provider think", report.providerThinkMs);
  if (report.marginalMs !== null) {
    console.log(`\n  MARGINAL OVERHEAD  ${report.marginalMs > 0 ? "+" : ""}${report.marginalMs}ms`);
  }
  console.log(`  ${out}\n`);
  if (streamTotals.length < rounds || directTotals.length < rounds) process.exitCode = 1;
  return report;
}
