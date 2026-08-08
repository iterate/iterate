// The two device-facing waits every endurance command needs: getting a call
// UP, and knowing when an answer has finished being HEARD.
//
// Both were closures inside `stress`, and both encode something measured
// rather than assumed — which is exactly why a second command must not write
// its own version from the same wrong first principles. They live here so
// `stress`, `sessions` and anything after them wait the same way.
import type { DeviceStats } from "./device-stats.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** How to press the call button and how to tell whether the press took. */
export interface BringCallUpOptions {
  /** Press call — `conversation.start()` on the device. */
  press: () => Promise<unknown>;
  /**
   * When the BRIDGE last said it had this call, as a timestamp; 0 for "no
   * call". Liveness has to come from `events.iterate.com/voice-agent/conversation-accepted` on the stream:
   * the device's own recording status is a proxy for a proxy, and a harness
   * that will not start because a diagnostic is unavailable tests the wrong
   * thing.
   */
  liveSince: () => number;
  /** Give up at this timestamp. */
  deadline: number;
  /** Narration for the one thing worth saying out loud: it died at once. */
  note?: (what: string) => void;
}

/**
 * Get a live call, pressing the call button as many times as it takes.
 *
 * Pressing once and waiting is not enough. Hanging up whatever was there and
 * starting a fresh call are two messages to a device that applies them in its
 * own loop, and the hang-up can land AFTER the new call has been accepted —
 * killing it. Measured on the first run of `stress`: `conversation-accepted`, then
 * `conversation-ended: button`, then sixty seconds of waiting for a call that had been
 * made and destroyed. So a call counts as live only once it has STAYED live.
 */
export async function bringCallUp(options: BringCallUpOptions): Promise<boolean> {
  const note = options.note ?? (() => {});
  while (Date.now() < options.deadline) {
    const pressedAt = Date.now();
    await options.press().catch((error: unknown) => {
      note(`the call button did not take: ${String(error)}`);
    });
    const answerBy = Math.min(options.deadline, Date.now() + 45_000);
    while (Date.now() < answerBy && options.liveSince() < pressedAt) await sleep(500);
    if (options.liveSince() < pressedAt) {
      /*
       * NEVER ACCEPTED: FAIL, DO NOT PRESS AGAIN.
       *
       * A second press makes a second bridge, and the stream showed exactly
       * that: two `conversation-requested`, two bridges, one `conversation-failed: superseded by
       * a newer bridge`, and a 16.2s "call live" that was really 8s of the first
       * bridge never answering plus a race. Pressing again hides a slow startup
       * behind a worse one.
       *
       * The retry below stays, because it answers a DIFFERENT question — a call
       * that was accepted and then immediately ended is a live race worth
       * re-pressing. One that was never accepted is a startup fault, and the
       * bounded deadline is the right verdict on it.
       */
      note(
        `the call was never accepted within ${Math.round((answerBy - pressedAt) / 1000)}s — ` +
          `not pressing again, because a second press makes a second bridge`,
      );
      return false;
    }
    await sleep(3000);
    if (options.liveSince() >= pressedAt) return true;
    note("the call was accepted and then ended at once — pressing again");
  }
  return false;
}

/** What a playout wait needs: the live sample series, and where it started. */
export interface QuietPlayoutOptions {
  /**
   * The device's dev-stats samples, appended to by the caller's watcher while
   * this waits. A live reference on purpose: the samples were arriving anyway,
   * so watching them costs nothing extra.
   */
  samples: readonly DeviceStats[];
  /** `spkPlayed` before the prompt. Flatness only counts once it has moved. */
  baselinePlayed: number;
  timeoutMs: number;
}

/**
 * Wait until the device's speaker stops advancing.
 *
 * `response.done` is not the end of an answer — the bridge forwards audio as
 * fast as the provider produces it, which is faster than realtime, so on a long
 * turn the device is still speaking after the answer is "finished". Asking the
 * next question then would barge in on our own audio and test something else
 * entirely. The device's own `spkPlayed` going flat for two consecutive samples
 * is the end.
 *
 * "Flat" alone is not enough, though, because a speaker that has not STARTED is
 * also flat. The playout primes before it opens the DAC, and — measured — a
 * device can refuse a whole answer outright and sit at exactly the reading it
 * had before. So flatness only counts once the counter has moved at all, and
 * never starting is reported as its own outcome rather than as a suspiciously
 * quick finish.
 */
export async function waitForQuietPlayout(
  options: QuietPlayoutOptions,
): Promise<"quiet" | "never started" | "still playing"> {
  const deadline = Date.now() + options.timeoutMs;
  const startBy = Math.min(deadline, Date.now() + 30_000);
  let seen = options.samples.length;
  let lastPlayed = options.baselinePlayed;
  let started = false;
  let flat = 0;
  while (Date.now() < deadline) {
    await sleep(500);
    if (options.samples.length === seen) {
      if (!started && Date.now() > startBy) return "never started";
      continue;
    }
    seen = options.samples.length;
    const played = Number(options.samples[options.samples.length - 1]!.spkPlayed ?? 0);
    if (played > lastPlayed) {
      started = true;
      flat = 0;
      lastPlayed = played;
      continue;
    }
    if (!started) {
      if (Date.now() > startBy) return "never started";
      continue;
    }
    flat++;
    if (flat >= 2) return "quiet";
  }
  return started ? "still playing" : "never started";
}
