// The journey a person actually does, over and over, from a cold boot.
//
// Everything else in this directory tests a PART: the bridge without a
// device, a call held open with text turns, a screenshot. None of them touch
// the microphone, and none of them start where a person starts — at the power
// button. So none of them could catch "I restarted it, pressed the button,
// spoke, and nothing came out", which is the only test that matters.
//
// One attempt is: restart the device, wait for it to come back, press call,
// wait for the call to be LIVE, hold push-to-talk, release, and then require
// that AUDIO WAS PLAYED — bytes written to the speaker, not a transcript
// event. A transcript proves the model answered; only the speaker counter
// proves the person heard it.
//
//   doppler run --config preview_3 -- pnpm cli voicelab reliability \
//     --project prj_… --attempts 10
import fs from "node:fs";
import {
  type VoicelabConnectOptions,
  connectProject,
  deviceCapability,
  deviceClientPath,
} from "./connect.ts";

/** Options for `pnpm cli voicelab reliability`. */
export interface ReliabilityOptions extends VoicelabConnectOptions {
  /** How many full journeys to run. */
  attempts?: number;
  /** Seconds to hold the talk button. */
  seconds?: number;
  /** Capability the device mounts itself under (itx.kit.<name>). */
  name?: string;
  /** Stream the call rides on. */
  path?: string;
  /** Write the full report here as JSON. */
  out?: string;
  /**
   * Set false to skip the reboot and isolate whether the reboot is what
   * breaks it. Defaults to TRUE: a person starts at the power button, and a
   * reliability test that quietly skips the restart is testing the easy half.
   */
  restart?: boolean;
}

interface DeviceCapability {
  conversation: { start(): Promise<boolean>; hangUp(): Promise<boolean> };
  pushToTalk: { start(): Promise<boolean>; stop(): Promise<boolean> };
  restart(): Promise<boolean>;
  health(): Promise<Record<string, unknown>>;
}

/** What one attempt is allowed to take, per step. */
const LIMITS = {
  /** A device coming back from a reboot and re-mounting its capability. */
  bootMs: 90_000,
  /** From pressing call to the bridge announcing it. */
  callLiveMs: 45_000,
  /** From releasing the button to audio arriving at the speaker. */
  answerMs: 30_000,
  /** Any single capability call. */
  rpcMs: 20_000,
};

const withTimeout = async <T>(label: string, run: () => Promise<T>, ms = LIMITS.rpcMs) => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function reliability(options: ReliabilityOptions) {
  const attempts = options.attempts ?? 10;
  const holdSeconds = options.seconds ?? 3;
  const streamPath = options.path ?? "/agents/voice/device";
  const capabilityName = options.name ?? "waveshare";
  /*
   * A FRESH itx session per attempt. The device reboots in the middle of this
   * test, which kills its capability and every stub any session holds on it —
   * so a harness that connects once spends the rest of the run reporting
   * "no capability kit.waveshare…" about a device that is perfectly fine.
   * A real client reconnects too; pretending otherwise tests the harness.
   */
  let itx = await connectProject(options);
  let stream = itx.streams.get(streamPath);
  let itxHandle = itx;
  const reconnect = async () => {
    try {
      (itx as unknown as { [Symbol.dispose]?: () => void })[Symbol.dispose]?.();
    } catch {
      /* already gone */
    }
    itx = await connectProject(options);
    stream = itx.streams.get(streamPath);
    itxHandle = itx;
  };

  const results: {
    attempt: number;
    ok: boolean;
    failedAt?: string;
    detail?: string;
    ms: Record<string, number>;
    spokeBytes?: number;
    transcript?: string;
  }[] = [];

  /*
   * One watcher for the whole run, opened before anything else: ephemeral
   * events only reach connections that already existed. It is reopened
   * between attempts because a device reboot does not take it down — but a
   * long run would otherwise spend its push budget.
   */
  let callLiveAt = 0;
  let answeredAt = 0;
  let transcript = "";
  const openWatch = (generation: number) =>
    stream.openConnection({
      connectionKey: `reliability-${Date.now()}-g${generation}`,
      eventTypes: [
        "events.iterate.com/voice-agent/grok-event",
        "events.iterate.com/voice-agent/conversation-accepted",
      ],
      processEventBatch: (batch: { events: { type: string; payload?: unknown }[] }) => {
        for (const event of batch.events) {
          if (event.type === "events.iterate.com/voice-agent/conversation-accepted") {
            callLiveAt = Date.now();
            continue;
          }
          const inner = (event.payload as { event?: { type?: string; delta?: string } })?.event;
          if (inner?.type === "response.output_audio_transcript.delta") {
            transcript += inner.delta ?? "";
          }
          if (inner?.type === "response.done") answeredAt = Date.now();
        }
      },
    });

  const device = () => {
    const capability = deviceCapability<DeviceCapability>(itxHandle, capabilityName);
    if (!capability) throw new Error(`${deviceClientPath(capabilityName)} is offline`);
    return capability;
  };

  let watch = await openWatch(0);

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const ms: Record<string, number> = {};
    const started = Date.now();
    let failedAt: string | undefined;
    let detail: string | undefined;
    let spokeBytes = 0;
    transcript = "";
    callLiveAt = 0;
    answeredAt = 0;

    const fail = (step: string, why: string) => {
      failedAt = step;
      detail = why;
      console.error(`  ✗ ${step}: ${why}`);
    };

    const step = (what: string) =>
      console.error(`  [${((Date.now() - started) / 1000).toFixed(1)}s] ${what}`);
    console.error(`attempt ${attempt}/${attempts}`);
    try {
      // 1. Cold start. This is where a person starts, and the state a reboot
      //    clears is exactly the state that hides bugs.
      if (options.restart !== false) {
        const at = Date.now();
        try {
          await withTimeout("restart", () => device().restart());
        } catch {
          /* The reply can be lost to the reboot itself; that is not a failure. */
        }
        await sleep(3000);
        /*
         * Wait for the device to come BACK — a fresh capability that answers.
         * The stub is re-resolved every poll because the old one belongs to a
         * session that died with the reboot.
         */
        let back = false;
        let lastBootError = "";
        /*
         * The restart REQUEST can be lost — the call it interrupts, a session
         * that dies underneath it, an RPC that times out — and a lost request
         * is not a device that failed to reboot. Left unretried it cost a
         * whole attempt: "did not come back within 90000ms (uptimeMs=159502)"
         * is a device that was never asked. So keep asking, and let uptime be
         * the thing that decides.
         */
        let askedAgainAt = at;
        while (Date.now() - at < LIMITS.bootMs && !back) {
          try {
            await reconnect();
            const health = (await withTimeout("health", () => device().health(), 8000)) as {
              uptimeMs?: number;
            };
            back = typeof health.uptimeMs === "number" && health.uptimeMs < 60_000;
            if (!back) {
              lastBootError = `uptimeMs=${String(health.uptimeMs)}`;
              if (Date.now() - askedAgainAt > 15_000) {
                askedAgainAt = Date.now();
                console.error(`  · still up (${lastBootError}); asking again`);
                await withTimeout("restart", () => device().restart()).catch(() => {});
              }
            }
          } catch (error) {
            lastBootError = String(error).slice(0, 100);
          }
          if (!back) await sleep(2000);
        }
        ms.boot = Date.now() - at;
        if (!back) {
          fail("boot", `did not come back within ${LIMITS.bootMs}ms (${lastBootError})`);
          throw new Error("boot");
        }
        console.error(`  · booted in ${(ms.boot / 1000).toFixed(1)}s`);
        // A reboot kills the watcher's peer; take a fresh one.
        try {
          watch.close();
        } catch {
          /* already gone */
        }
        watch = await openWatch(attempt);
      }

      // 2. Press call, and require the BRIDGE to say the call is live.
      {
        const at = Date.now();
        callLiveAt = 0;
        await withTimeout("hangUp", () => device().conversation.hangUp()).catch(() => {});
        await sleep(1500);
        step("pressing call");
        await withTimeout("press call", () => device().conversation.start());
        while (Date.now() - at < LIMITS.callLiveMs && callLiveAt < at) await sleep(250);
        ms.callLive = Date.now() - at;
        if (callLiveAt < at) {
          fail("call", `no conversation-accepted within ${LIMITS.callLiveMs}ms`);
          throw new Error("call");
        }
        console.error(`  · call live in ${(ms.callLive / 1000).toFixed(1)}s`);
      }

      // 3. Hold the button, speak into it (silence, but the mic path is real),
      //    release. This is the path text turns never touch.
      const beforeSpeaking = (await withTimeout("health", () => device().health())) as Record<
        string,
        number
      >;
      {
        const at = Date.now();
        step("holding talk");
        await withTimeout("hold talk", () => device().pushToTalk.start());
        await sleep(holdSeconds * 1000);
        step("releasing talk");
        await withTimeout("release talk", () => device().pushToTalk.stop());
        ms.turn = Date.now() - at;
      }

      // 4. The only thing that counts: did the SPEAKER play anything.
      //    A transcript proves the model answered. Bytes written to the codec
      //    prove the person in the room heard it.
      {
        step("waiting for audio");
        const at = Date.now();
        while (Date.now() - at < LIMITS.answerMs) {
          const health = (await withTimeout("health", () => device().health(), 8000).catch(
            () => ({}),
          )) as Record<string, number>;
          spokeBytes = Number(health.spkWrites ?? 0) - Number(beforeSpeaking.spkWrites ?? 0);
          if (spokeBytes > 0 && answeredAt > 0) break;
          await sleep(1000);
        }
        ms.answer = Date.now() - at;
        if (spokeBytes <= 0) {
          /*
           * "Answered but silent" has two completely different causes and the
           * device can tell them apart: a delivery lane that stopped existing
           * (batchAgeMs large, and a recycle it did or did not manage) versus
           * audio that arrived and was not played. Ask before giving up, or
           * the report says the same words for both.
           */
          const why = (await withTimeout("health", () => device().health(), 8000).catch(
            () => ({}),
          )) as Record<string, number>;
          const lane = `batchAgeMs=${why.batchAgeMs} batches=${why.batches} conn=${why.connGeneration} recycles=${why.downlinkRecycles} spkFrames=${why.spkFrames} conceal=${why.spkConceal}`;
          fail(
            "audio",
            answeredAt > 0
              ? `the model answered but the speaker played nothing (${lane}) (transcript: ${transcript.slice(0, 60)})`
              : `no answer and no audio (${lane})`,
          );
          throw new Error("audio");
        }
        console.error(
          `  ✓ ${spokeBytes} speaker writes in ${(ms.answer / 1000).toFixed(1)}s: ${transcript.slice(0, 60)}`,
        );
      }
    } catch (error) {
      /*
       * An attempt that threw is a FAILED attempt, always. The first version
       * of this only recorded failures it had anticipated, so an unexpected
       * throw — a capability that was not there, a stub belonging to a dead
       * session — ended the attempt early and reported it as a pass, with
       * zero bytes played. A test that can report success without observing
       * success is worse than no test.
       */
      if (failedAt === undefined) fail("unexpected", String(error).slice(0, 140));
    }

    ms.total = Date.now() - started;
    results.push({
      attempt,
      detail,
      failedAt,
      ms,
      ok: failedAt === undefined,
      spokeBytes,
      transcript: transcript.slice(0, 120),
    });
    await sleep(2000);
  }

  try {
    watch.close();
  } catch {
    /* already gone */
  }

  const passed = results.filter((result) => result.ok).length;
  const byStep: Record<string, number> = {};
  for (const result of results) {
    if (result.failedAt) byStep[result.failedAt] = (byStep[result.failedAt] ?? 0) + 1;
  }
  const summary = {
    attempts: results.length,
    failuresByStep: byStep,
    passed,
    /* The number that matters. Anything below 100% is a broken device. */
    rate: `${((passed / results.length) * 100).toFixed(0)}%`,
  };
  console.log(JSON.stringify({ results, summary }, null, 2));
  if (options.out) fs.writeFileSync(options.out, JSON.stringify({ results, summary }, null, 2));
  if (passed !== results.length) process.exitCode = 1;
}
