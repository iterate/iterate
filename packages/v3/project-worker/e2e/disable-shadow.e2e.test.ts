// disable-shadow.e2e.test.ts — LIFECYCLE BUG: disableProcessor pops only the NEWEST mount off the
// shadow stack, so a processor enabled TWICE (the supported "re-enable while warm" scenario) is
// NOT disabled by one disableProcessor call — the older shadowed mount resurfaces and the
// processor keeps running (while its facet storage was just deleted → it silently re-reduces the
// whole log from offset 0).
//
// ROOT CAUSE: stream-durable-object.ts disableProcessor() → revokeCapability({ path:
// `itx.subscribers.<slug>` }) → revokeCapability picks `.sort(desc)[0]` (the single NEWEST mount)
// and revokes only it. #activeSubscriptionMounts() then re-elects the older survivor as the active
// mount → #facetEntries() still lists the slug → host state shows it enabled, the next commit
// re-materializes the facet.
//
// CONTROL (single enable → single disable) is included and MUST pass (proves the harness is sane).
// (was proofs/prove_disable_shadow.mjs)

import { expect, test } from "vitest";
import { freshCtx, bareItx, sleep } from "./support/client.ts";

// Drive one ctx through: enable ×N, append+snapshot, ONE disable, then probe host state and the facet.
// Returns the two asserted facts: whether host state still lists the slug, and whether snapshot throws
// NO_FACET (a truly-disabled processor throws). Each call opens its OWN fresh session.
async function run(
  prefix: string,
  enableTimes: number,
): Promise<{ stillListed: boolean; throws: boolean }> {
  const itx = bareItx(freshCtx(prefix));
  const append = (...events: unknown[]): Promise<unknown> =>
    itx.invokeCapability(["itx", ["append", ...events]]);
  const snap = (): Promise<{ state?: { counts?: Record<string, number> }; offset: number }> =>
    itx.invokeCapability("itx.facets.get('tally').snapshot()");

  for (let i = 0; i < enableTimes; i++) await itx.enableProcessor("tally");
  await append({ type: "mark" });
  await snap(); // enabled: tally counts the mark (materializes the facet)

  // THE DISABLE — one call
  await itx.disableProcessor("tally");

  const st1 = (await itx.hostState()) as { facetProcessors: string[] };
  const stillListed = st1.facetProcessors.includes("tally");

  // Does the facet still answer? A truly-disabled processor throws NO_FACET.
  let snapErr: string | undefined;
  try {
    await snap();
  } catch (e) {
    snapErr = String(e);
  }
  const throws = /no facet/i.test(snapErr ?? "");

  // Append once more and see whether a "disabled" processor keeps counting (observational).
  await append({ type: "mark2" });
  await sleep(400);
  try {
    await snap();
  } catch {
    /* NO_FACET if genuinely disabled */
  }

  return { stillListed, throws };
}

// CONTROL: single enable, single disable → the processor is genuinely off.
test("[control] single enable then disable: processor is genuinely off", async () => {
  const control = await run("disshadow-ctl", 1);
  // host state no longer lists tally
  expect(control.stillListed).toBe(false);
  // snapshot throws NO_FACET
  expect(control.throws).toBe(true);
});

// Was THE BUG when authored: double enable (shadow stack), single disable → disableProcessor popped
// only the newest shadowed mount, so the processor stayed running. FIXED — now the regression pin.
test("double-enable then ONE disable: processor MUST be off", async () => {
  const bug = await run("disshadow-bug", 2);
  // host state must NOT list tally (else the shadowed mount resurfaced)
  expect(bug.stillListed).toBe(false);
  // snapshot must throw NO_FACET (else the facet still answers — processor not disabled)
  expect(bug.throws).toBe(true);
});
