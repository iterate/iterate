// stream-woken-and-inline-live-state.e2e.test.ts — the WAKE RECORD + inline live state, LIVE. The
// context DO's CONSTRUCTOR appends the platform's own records before any door opens (the apps/os
// shape): the first-ever incarnation writes events.iterate.com/stream/created { projectId, path } at
// offset 1 and events.iterate.com/stream/woken { incarnation } at offset 2; every later incarnation
// writes woken as its first event. So ANY door on a never-touched context materializes it — a bare
// read, a probe, an append — and the first user append lands past both records. The core reduce
// reduces them into `state.projectId / path / createdAt / incarnation`, and the ONE inline reduced
// state (key `core`: identity, pause, rewrite rules, subscriptions) emits the standard ephemeral
// live-state/changed deltas on change, delivered to a subscriber that names the one live-state
// event type — exactly like any facet processor's.

import { expect, test } from "vitest";
import { freshCtx, openItx, until } from "./support/client.ts";
import { deltasFor, LIVE_STATE_CHANGED, type Delta } from "./support/live-client.ts";

test("any door materializes a fresh context: readEvents(0) starts with created then woken; the first append lands past them; core's reduced state carries identity + incarnation", async () => {
  const ctx = freshCtx("woken");
  const itx = openItx(ctx);
  // A bare READ on a never-touched context already sees the two records — the constructor wrote
  // them before this door opened.
  const page = await itx.invoke("itx.readEvents(0)");
  expect(page.events.map((e: { type: string; offset: number }) => [e.type, e.offset])).toEqual([
    ["events.iterate.com/stream/created", 1],
    ["events.iterate.com/stream/woken", 2],
  ]);
  expect(page.events[0].payload).toEqual({ projectId: ctx, path: "/" });
  const incarnation = page.events[1].payload.incarnation;
  expect(incarnation).toBeGreaterThanOrEqual(1);

  // one receipt per INPUT — the platform's records are never echoed as receipts — and the first
  // user append lands at offset 4: past created (1), woken (2) and core's ephemeral live-state
  // delta for the wake commit (3; ephemerals share the offset sequence).
  const receipts = await itx.invoke(`itx.append({ type: 'hello' })`);
  expect(receipts).toHaveLength(1);
  expect(receipts[0].type).toBe("hello");
  expect(receipts[0].offset).toBe(4);

  // the core reduce reduced both records — runtime state IS reduced state
  const snap = await itx.invoke("itx.facets.get('core').snapshot()");
  expect(snap.state).toMatchObject({ projectId: ctx, path: "/", incarnation });
  expect(snap.state.createdAt).toBe(page.events[0].createdAt);

  // exactly once per incarnation (and born exactly once, ever)
  await itx.invoke(`itx.append({ type: 'again' })`);
  const types = (await itx.invoke("itx.readEvents(0)")).events.map((e: { type: string }) => e.type);
  expect(types.filter((t: string) => t === "events.iterate.com/stream/woken")).toHaveLength(1);
  expect(types.filter((t: string) => t === "events.iterate.com/stream/created")).toHaveLength(1);
});

test("the inline reduced state is live under ONE key, `core`: a rewrite rule and a subscription row both reach a live-state subscriber as `core` deltas", async () => {
  const itx = openItx(freshCtx("inlinelive"));
  await itx.invoke(`itx.append({ type: 'seed' })`);

  // ONE event type carries every key's deltas; each watcher keeps its key (deltasFor). Two other
  // keys — the names of core's slices — are watched too: they must stay silent (nothing publishes
  // under any key but `core`).
  const coreDeltas: Delta[] = [];
  const otherKeys: Delta[] = [];
  await itx.subscribe({
    name: "corewatch",
    target: deltasFor({ consume: (d) => coreDeltas.push(d) }, "core"),
    consumes: [LIVE_STATE_CHANGED],
  });
  for (const key of ["rewrite-rules", "subscriptions"])
    await itx.subscribe({
      name: `other-${key}`,
      target: deltasFor({ consume: (d) => otherKeys.push(d) }, key),
      consumes: [LIVE_STATE_CHANGED],
    });
  const seen = coreDeltas.length; // the subscribes above are themselves core changes

  // a REWRITE RULE (a rewrite) → a delta keyed "core" whose patch touches /itxExpressionRewriteRules
  await itx.provide("itx.zzz", "itx.whoami");
  const ruleDelta = await until("core delta for the rewrite rule", () =>
    coreDeltas
      .slice(seen)
      .find((d) => d.patch.some((op) => op.path.startsWith("/itxExpressionRewriteRules"))),
  );
  expect(ruleDelta.key).toBe("core");
  expect(ruleDelta.to).toBe(ruleDelta.from + 1); // each emission chains its producer revision

  // a SUBSCRIPTION ROW (a subscribe) → a delta keyed "core" whose patch touches /subscriptions
  await itx.subscribe({ name: "bystander", target: "itx.whoami", consumes: ["never"] });
  const rowDelta = await until("core delta for the row", () =>
    coreDeltas
      .slice(seen)
      .find((d) => d.patch.some((op) => op.path.startsWith("/subscriptions/bystander"))),
  );
  expect(rowDelta.key).toBe("core");
  expect(rowDelta.to).toBe(rowDelta.from + 1);

  // and nothing ever published under any other key
  expect(otherKeys).toEqual([]);
});
