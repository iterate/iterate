// test-support/config-worker.ts — publishing a project's config worker, one copy for the e2e and
// Workers suites. It imports only `iterate/lib`, so it loads in Node and in workerd alike.
import { errorCode } from "iterate/lib";

/** Publish `target` as the project's config worker — what EVERY host of the project reaches, the
 *  routing slug in `x-iterate-routing-slug` — once the project's own creation saga has settled: the
 *  saga publishes the seeded config repo, and an append before it lands would be overwritten. The
 *  wait is a minute of fresh 5 s calls (src/project/collection.ts `TERMINAL_WAIT_SLICE_MS` says
 *  why). */
export async function publishConfigWorker(itx: any, target: unknown) {
  const started = Date.now();
  for (;;) {
    const remainingMs = started + 60_000 - Date.now();
    try {
      await itx.waitForEvent({
        type: ["events.iterate.com/project/created", "events.iterate.com/project/create-failed"],
        afterOffset: 0,
        timeoutMs: Math.min(5_000, remainingMs),
      });
      break;
    } catch (error) {
      if (errorCode(error) !== "WAIT_TIMEOUT" || remainingMs <= 5_000) throw error;
    }
  }
  await itx.append({ type: "events.iterate.com/itx/ingress-configured", payload: { target } });
}
