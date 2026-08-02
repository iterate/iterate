// Hold a call open for a long time, take turns on it, and watch everything.
//
// The target is an hour-long conversation, and nothing shorter than an hour
// tells you whether you have one: every failure this lab has had — the push
// budget running out, a bridge evicted without saying so, a stream Durable
// Object slowing down as it fills, a half-open socket nobody notices —
// arrives on a clock, not on the first turn.
//
// So this drives turns for as long as you ask, and reports what it saw as
// counters over TIME rather than a snapshot. It is deliberately hostile to
// its own conclusions: an unanswered turn, a session that changed generation,
// a bridge that had to be replaced, are all failures, and it says so.
//
//   doppler run --config preview_3 -- pnpm cli voicelab soak \
//     --project prj_… --minutes 60 --every 45
import fs from "node:fs";
import { connectProject, type VoicelabConnectOptions } from "./connect.ts";

/** Options for `pnpm cli voicelab soak`. */
export interface SoakOptions extends VoicelabConnectOptions {
  /** How long to keep the conversation going. */
  minutes?: number;
  /** Seconds between turns. */
  every?: number;
  /** Stream the call rides on. */
  path?: string;
  /** Capability the device mounts itself under (itx.kit.<name>). */
  name?: string;
  /** Write the full timeline here as JSON. */
  out?: string;
  /**
   * Take turns with the microphone (holding the device's talk button) rather
   * than with text. The mic path is what a person uses; the text path exists
   * so a soak can run with nobody in the room to make a noise.
   */
  mic?: boolean;
}

/** One dev-stats sample, as the device reports it. */
interface DeviceStats {
  seq: number;
  t: number;
  uptimeMs?: number;
  sessionGeneration?: number;
  connGeneration?: number;
  livenessRestarts?: number;
  bridgeLosses?: number;
  pings?: number;
  pingFailures?: number;
  rttMs?: number;
  spkUnderruns?: number;
  spkConceal?: number;
  spkOverflow?: number;
  spkSeqGaps?: number;
  spkWriteFailures?: number;
  spkFrames?: number;
  framesSent?: number;
  frameFailures?: number;
  sendFailures?: number;
  recvFailures?: number;
  protoFailures?: number;
  inboxDiscarded?: number;
  outboxDiscarded?: number;
  heapFree?: number;
  heapMin?: number;
  [key: string]: unknown;
}

interface DeviceCapability {
  conversation: { start(): Promise<boolean>; hangUp(): Promise<boolean> };
  pushToTalk: { start(): Promise<boolean>; stop(): Promise<boolean> };
  recording: { status(): Promise<{ recording?: boolean }> };
}

/** Counters that must never move during a healthy soak. */
const MUST_NOT_MOVE = [
  "livenessRestarts",
  "bridgeLosses",
  "spkOverflow",
  "spkSeqGaps",
  "spkWriteFailures",
  "frameFailures",
  "sendFailures",
  "recvFailures",
  "protoFailures",
  "inboxDiscarded",
  "outboxDiscarded",
  "pingFailures",
] as const;

const PROMPTS = [
  "In one sentence: why is the sky blue?",
  "Name one interesting fact about octopuses.",
  "What is a good reason to write things down?",
  "Say something short about the sea.",
  "In one sentence, what makes bread rise?",
  "Tell me one short thing about volcanoes.",
];

export async function soak(options: SoakOptions) {
  const minutes = options.minutes ?? 60;
  const everyMs = (options.every ?? 45) * 1000;
  const streamPath = options.path ?? "/voicelab/device";
  using itx = await connectProject(options);
  const kit = (itx as unknown as { kit: Record<string, DeviceCapability> }).kit;
  const capability = kit[options.name ?? "waveshare"];
  if (!capability) throw new Error(`no device capability named ${options.name ?? "waveshare"}`);
  const stream = itx.streams.get(streamPath);

  const startedAt = Date.now();
  const samples: DeviceStats[] = [];
  const turns: { at: number; index: number; answeredMs?: number; text?: string }[] = [];
  const events: { at: number; what: string }[] = [];
  const note = (what: string) => {
    events.push({ at: Date.now() - startedAt, what });
    console.error(`[${((Date.now() - startedAt) / 1000).toFixed(0)}s] ${what}`);
  };

  /*
   * Open the watch BEFORE anything else: dev-stats and every audio frame are
   * ephemeral, and an ephemeral event only reaches connections that already
   * existed when it was appended. A watcher opened later sees a suspiciously
   * healthy call, because it cannot see the part that went wrong.
   */
  let answering: { resolve: (text: string) => void; text: string } | null = null;
  /* When the bridge last announced it had this call. */
  let callLiveAt = 0;
  let lastDelivery = Date.now();
  let watchGeneration = 0;
  let watchReopens = 0;
  let redials = 0;
  const openWatch = () =>
    stream.openConnection({
      connectionKey: `soak-${startedAt}-g${++watchGeneration}`,
      eventTypes: [
        "voicelab/dev-stats",
        "voicelab/grok-event",
        "voicelab/call-accepted",
        "voicelab/call-ended",
        "voicelab/bridge-redialling",
      ],
      /*
       * Speaker frames are deliberately NOT subscribed. They are the bulk of
       * the traffic, this watcher does not play them, and every one delivered
       * here spends the connection's push budget — a measuring instrument
       * that exhausts the thing it measures is worse than none.
       */
      processEventBatch: (batch: { events: { type: string; payload?: unknown }[] }) => {
        lastDelivery = Date.now();
        for (const event of batch.events) {
          const payload = (event.payload ?? {}) as Record<string, unknown>;
          if (event.type === "voicelab/dev-stats") {
            samples.push(payload as unknown as DeviceStats);
            continue;
          }
          if (event.type === "voicelab/call-accepted") {
            callLiveAt = Date.now();
            note(`call-accepted by bridge ${String(payload.bridgeId)}`);
            continue;
          }
          if (event.type === "voicelab/call-ended") {
            note(`CALL ENDED: ${String(payload.reason)}`);
            continue;
          }
          if (event.type === "voicelab/bridge-redialling") {
            /*
             * Not a failure: the provider closes its socket on its own
             * schedule and the bridge replaces it underneath the
             * conversation. Worth counting — a redial per turn would mean
             * something else is wrong — but the turns are the verdict.
             */
            redials++;
            note(`bridge redialling (${String(payload.reason)})`);
            continue;
          }
          const inner = (payload as { event?: { type?: string; delta?: string } }).event;
          if (inner?.type === "response.output_audio_transcript.delta" && answering) {
            answering.text += inner.delta ?? "";
          }
          if (inner?.type === "response.done" && answering) answering.resolve(answering.text);
        }
      },
    });
  let connection = await openWatch();
  /*
   * The watcher has to prove its own connection, exactly as the device does.
   * A session connection dies quietly — the push budget runs out, the Durable
   * Object resets — and a dead watcher does not report an error, it reports a
   * silent call. The first run of this soak "found" four unanswered turns in
   * a row that the bridge had in fact answered: what had actually stopped was
   * the watching.
   *
   * The device appends dev-stats every 5s, so a 15s gap is evidence, and
   * make-before-break means nothing is missed across the swap.
   */
  const watchdog = setInterval(() => {
    if (Date.now() - lastDelivery < 15_000) return;
    lastDelivery = Date.now();
    watchReopens++;
    note("watch went quiet — reopening (the watcher, not the call)");
    void openWatch().then(
      (next) => {
        const previous = connection;
        connection = next;
        previous.close();
      },
      () => {},
    );
  }, 5000);

  const waitForAnswer = async (timeoutMs: number) => {
    const started = Date.now();
    let done: (text: string) => void = () => {};
    const answered = new Promise<string>((resolve) => {
      done = resolve;
    });
    answering = { resolve: done, text: "" };
    const text = await Promise.race([
      answered,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    answering = null;
    return { ms: Date.now() - started, text };
  };

  note(`soak begins: ${minutes} minutes, a turn every ${everyMs / 1000}s, on ${streamPath}`);
  await capability.conversation.hangUp().catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 3000));
  /*
   * Stamped BEFORE the press: the call can be accepted while the press RPC is
   * still resolving, and a liveness test that misses its own evidence is the
   * kind of flake that gets blamed on the device.
   */
  const pressedAt = Date.now();
  await capability.conversation.start();
  {
    /*
     * Live means THE BRIDGE SAID SO — a call-accepted on this stream. It used
     * to mean "the device says it is recording", which is a proxy for a
     * proxy: the SD card is optional, its state lags by a task hop, and a
     * soak that will not start because a diagnostic is unavailable is a soak
     * that tests the wrong thing.
     */
    const deadline = pressedAt + 60_000;
    while (Date.now() < deadline && callLiveAt < pressedAt) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const live = callLiveAt >= pressedAt;
    note(live ? "call is live" : "CALL NEVER WENT LIVE");
    if (!live) {
      clearInterval(watchdog);
      connection.close();
      throw new Error("the call never went live; nothing to soak");
    }
  }

  const endAt = startedAt + minutes * 60_000;
  let index = 0;
  let unanswered = 0;
  while (Date.now() < endAt) {
    const turnAt = Date.now();
    index++;
    const prompt = PROMPTS[index % PROMPTS.length]!;
    if (options.mic) {
      // The real path: hold the button, say nothing, let go. Proves the
      // commit and the answer, and exercises the uplink under a live turn.
      await capability.pushToTalk.start().catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 2500));
      await capability.pushToTalk.stop().catch(() => {});
    } else {
      await stream.append({
        payload: { text: prompt },
        type: "voicelab/say",
      });
    }
    const answer = await waitForAnswer(45_000);
    turns.push({
      answeredMs: answer.text === null ? undefined : answer.ms,
      at: turnAt - startedAt,
      index,
      text: answer.text?.slice(0, 60) ?? undefined,
    });
    if (answer.text === null) {
      unanswered++;
      note(`turn ${index}: NO ANSWER in 45s`);
    } else {
      note(`turn ${index}: answered in ${(answer.ms / 1000).toFixed(1)}s`);
    }
    const wait = turnAt + everyMs - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  }

  clearInterval(watchdog);
  connection.close();
  await capability.conversation.hangUp().catch(() => {});

  const first = samples[0];
  const last = samples[samples.length - 1];
  const moved: Record<string, number> = {};
  if (first && last) {
    for (const key of MUST_NOT_MOVE) {
      const delta = Number(last[key] ?? 0) - Number(first[key] ?? 0);
      if (delta !== 0) moved[key] = delta;
    }
  }
  const answeredTurns = turns.filter((turn) => turn.answeredMs !== undefined);
  const latencies = answeredTurns.map((turn) => turn.answeredMs!).sort((a, b) => a - b);
  const summary = {
    answered: answeredTurns.length,
    /* A device that rebooted looks perfectly healthy afterwards: its counters
     * start again from zero. Uptime going BACKWARDS is the only way to see it. */
    reboots: samples.filter(
      (sample, at) =>
        at > 0 && Number(sample.uptimeMs ?? 0) < Number(samples[at - 1]!.uptimeMs ?? 0),
    ).length,
    counters: {
      conceal: Number(last?.spkConceal ?? 0) - Number(first?.spkConceal ?? 0),
      framesSent: Number(last?.framesSent ?? 0) - Number(first?.framesSent ?? 0),
      spkFrames: Number(last?.spkFrames ?? 0) - Number(first?.spkFrames ?? 0),
      underruns: Number(last?.spkUnderruns ?? 0) - Number(first?.spkUnderruns ?? 0),
    },
    heapMin: Number(last?.heapMin ?? 0),
    latencyMs: {
      max: latencies[latencies.length - 1] ?? null,
      median: latencies[Math.floor(latencies.length / 2)] ?? null,
      min: latencies[0] ?? null,
    },
    minutes: Number(((Date.now() - startedAt) / 60_000).toFixed(1)),
    sessionGenerations: new Set(samples.map((sample) => sample.sessionGeneration)).size,
    shouldNotHaveMoved: moved,
    statsSamples: samples.length,
    turns: turns.length,
    unanswered,
    /* Not a device fault: this is how often the WATCHER had to be replaced. */
    watchReopens,
    /* How often the bridge replaced its provider socket under the call. */
    bridgeRedials: redials,
  };
  const verdict =
    unanswered === 0 && Object.keys(moved).length === 0 && summary.reboots === 0 ? "PASS" : "FAIL";
  console.log(JSON.stringify({ summary, verdict }, null, 2));
  if (options.out) {
    fs.writeFileSync(
      options.out,
      JSON.stringify({ events, samples, summary, turns, verdict }, null, 2),
    );
    console.error(`timeline: ${options.out}`);
  }
  if (verdict === "FAIL") process.exitCode = 1;
}
