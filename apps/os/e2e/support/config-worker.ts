// e2e/support/config-worker.ts — publishing a project's config worker, one copy for the e2e and
// Workers suites. It imports nothing, so it loads in Node and in workerd alike.

/** Publish `target` as the project's config worker — what EVERY host of the project reaches, the
 *  routing slug in `x-iterate-routing-slug` — once the project's own creation saga has settled: the
 *  saga publishes the seeded config repo, and an append before it lands would be overwritten. */
export async function publishConfigWorker(itx: any, target: unknown) {
  await itx.waitForEvent({
    type: ["events.iterate.com/project/created", "events.iterate.com/project/create-failed"],
    afterOffset: 0,
    timeoutMs: 60_000,
  });
  await itx.append({ type: "events.iterate.com/itx/ingress-configured", payload: { target } });
}
