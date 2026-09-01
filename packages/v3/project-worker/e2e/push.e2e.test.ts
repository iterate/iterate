// push.e2e.test.ts — the ABSENT-TARGET lane live: the subscription-forwarder facet drives a
// stateless processEvent-style worker from its own SubscriptionDeliveryProgress cursor; the ONE
// failure policy (bounded retries → HALT + audit fact); resumeSubscription as the one recovery
// verb; auto-enablement of the forwarder by the first absent-target subscribe.
// (was proofs/prove_push.mjs)

import { expect, test } from "vitest";
import { freshCtx, openItx, until } from "./support/client.ts";
import { seedSources } from "./support/sources.ts";

test("absent-target forwarder lane: retry→halt policy, resume recovery, auto-enablement", async () => {
  const itx = openItx(freshCtx("push"));
  await seedSources(itx, ["digest"]);

  // 1. mount the stateless digest cap + the "*" tally (to observe audit facts)
  await itx.enableProcessor("tally");
  await itx.provide({
    path: "itx.digest",
    target: `itx.load("itx.kv.get('src/digest.js')").getEntrypoint()`,
  });

  // 2. subscribe with an ABSENT target → the subscription-forwarder facet is auto-enabled and
  // owns the cursor. maxAttempts bounds the ONE retry-then-halt ladder (small here so the halt
  // proof runs in seconds; the production default is 15).
  const sub = await itx.subscribe({
    name: "digest",
    target: "itx.digest.run",
    consumes: ["mark"],
    maxAttempts: 2,
    start: "beginning",
  });
  expect(sub.name).toBe("digest"); // subscribe returns the row name

  // 3. three good marks → the worker's own kv shows 3 (the awaited call IS the ack)
  for (let i = 0; i < 3; i++) await itx.invokeCapability(`itx.append({ type: 'mark' })`);
  const digested3 = await until(
    "digest=3",
    async () => {
      const v = await itx.invokeCapability(["itx", "kv", ["get", "digested"]]);
      return v === "3" ? v : undefined;
    },
    30_000,
  );
  expect(digested3).toBe("3"); // stateless worker digested 3 marks via the forwarder

  // 4. a poison mark: digest stamps `retryable: false` on its error, so the forwarder HALTS
  // IMMEDIATELY with an audit fact — no ladder burned on an error that can never succeed
  // (the stamped-flag doctrine from core/errors.ts). No skip, no pinning: ONE policy.
  const [poisoned] = await itx.invokeCapability(
    `itx.append({ type: 'mark', payload: { poison: true } })`,
  );
  await itx.invokeCapability(`itx.append({ type: 'mark' })`); // a good one stuck behind it
  const tallyAfterHalt = await until(
    "halt audit fact",
    async () => {
      const t = await itx.invokeCapability("itx.facets.get('tally').snapshot()");
      return (t.state.counts["events.iterate.com/stream/subscription-delivery-halted"] ?? 0) >= 1
        ? t
        : undefined;
    },
    60_000,
  );
  // retryable: false → immediate HALT left an audit fact on the stream
  expect(tallyAfterHalt).toBeDefined();
  const digestedStill3 = await itx.invokeCapability(["itx", "kv", ["get", "digested"]]);
  expect(digestedStill3).toBe("3"); // halted subscription delivered nothing more

  // 5. resumeSubscription past the poison — THE one recovery verb — and the stuck good mark lands
  await itx.resumeSubscription({ name: "digest", afterOffset: poisoned.offset });
  const digested4 = await until(
    "digest=4 (past the poison)",
    async () => {
      const v = await itx.invokeCapability(["itx", "kv", ["get", "digested"]]);
      return v === "4" ? v : undefined;
    },
    60_000,
  );
  expect(digested4).toBe("4"); // resume({afterOffset}) skipped the poison, delivered the good mark

  // 6. host state: the row rides the forwarder lane; the forwarder facet was auto-enabled
  const state = await itx.hostState();
  const row = state.subscriptionMounts?.find((r: { name: string }) => r.name === "digest");
  // host state: absent-target row on the durable lane, forwarder facet auto-enabled
  expect(row?.lane).toBe("durable");
  expect(state.facetProcessors).toContain("subscription-forwarder");
});
