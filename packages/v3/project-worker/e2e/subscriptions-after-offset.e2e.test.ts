// subscriptions-after-offset.e2e.test.ts — `itx.subscribe({ afterOffset })` (the userspace-apps
// assessment's Gap 6): a cursor-lane subscriber may ask for HISTORY. Its cursor is born at
// `afterOffset` (0 = the whole log) instead of at the configure offset, and the configure is its wake,
// so events that landed BEFORE the subscription are delivered — at-least-once, from the cursor THE
// STREAM keeps. Nothing else changes: the target (the stateless `digest` worker) still cannot own its
// progress, the loop still classifies it by evaluating it; only where the cursor starts moved.

import { expect, test } from "vitest";
import { freshCtx, openItx, until } from "./support/client.ts";
import { SOURCES } from "./support/sources.ts";

/** The `digest` fixture counts every delivered event into kv `digested`. */
const digested = async (itx: any): Promise<number> => Number((await itx.kv.get("digested")) ?? 0);

test("subscribe({ afterOffset: 0 }) delivers the marks that landed BEFORE the subscription; the same subscribe without it delivers only what lands after", async () => {
  const itx = openItx(freshCtx("afteroffset"));
  await itx.provide("itx.digest", ["itx", "workers", ["get", { source: SOURCES.digest }]]);

  // 1. three marks with NO subscription in place
  for (let i = 0; i < 3; i++) await itx.append({ type: "mark" });

  // 2. the control — subscribe from NOW: the three are never delivered; a fourth mark lands and is
  await itx.subscribe({
    name: "digest",
    target: "itx.digest.processEventBatch",
    consumes: ["mark"],
  });
  const [fourth] = await itx.append({ type: "mark" });
  await until(
    "digest=1 (only the mark after the subscribe)",
    async () => (await digested(itx)) === 1,
    30_000,
  );
  const fromNow = await until("cursor past the fourth mark", async () => {
    const row = await itx.subscriptions.get("digest");
    return row?.cursor && row.cursor.confirmedOffset >= fourth.offset ? row : undefined;
  });
  expect(fromNow.halted).toBeUndefined();

  // 3. the claim — the same name RE-SUBSCRIBED (a fresh row, a fresh cursor) asking for the whole log:
  //    all four marks are delivered again, from offset 0 — 1 → 5 — and the cursor lands at the head
  await itx.subscribe({
    name: "digest",
    target: "itx.digest.processEventBatch",
    consumes: ["mark"],
    afterOffset: 0,
  });
  await until(
    "digest=5 (the four marks, from offset 0)",
    async () => (await digested(itx)) === 5,
    30_000,
  );
  const fromHistory = await until("cursor past the fourth mark again", async () => {
    const row = await itx.subscriptions.get("digest");
    return row?.cursor && row.cursor.confirmedOffset >= fourth.offset ? row : undefined;
  });
  expect(fromHistory.configuredAtOffset).toBeGreaterThan(fromNow.configuredAtOffset); // a new row
  expect(fromHistory.cursor.attempt).toBe(0);
  expect(fromHistory.halted).toBeUndefined();
  expect(await digested(itx)).toBe(5); // exactly the four, once each
});
