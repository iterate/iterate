// stream-core-reduce.e2e.test.ts — THE CORE REDUCE live: the stream's operational truth reduced
// INLINE at the commit point (the apps/os shape). Control is ordinary events; enforcement is the
// parent reading the reduce. Proves: pause refuses appends (control passes), resume heals, ephemerals
// flow when unpaused, and the ONE core snapshot exposes the whole core truth — identity (created),
// incarnation (woken), pause, the rewrite rules and the subscription rows (runtime state IS reduced
// state — hostState() died in C5; the breaker left core for a facet processor, see
// processor-facet-breaker-pauses-the-stream.e2e).

import { expect, test } from "vitest";
import { freshCtx, openItx } from "./support/client.ts";

test("core reduce: pause/resume, ephemerals flow when unpaused, ONE core snapshot carries identity + incarnation + pause + rewrite rules + subscriptions", async () => {
  const ctx = freshCtx("core");
  const itx = openItx(ctx);

  const append = (type: string, payload?: Record<string, unknown>): Promise<unknown> =>
    itx.invoke(`itx.append(${JSON.stringify({ type, ...(payload && { payload }) })})`);
  // Runs `fn`; returns "ok" if it rejects with a message matching `re`, null if it resolves, else
  // the (truncated) mismatched error message.
  const rejects = async (fn: () => Promise<unknown>, re: RegExp): Promise<string | null> => {
    try {
      await fn();
      return null;
    } catch (e) {
      const msg = String((e as { message?: string })?.message ?? e);
      return re.test(msg) ? "ok" : msg.slice(0, 90);
    }
  };

  // ── pause ──
  await append("work"); // establish the stream
  await append("events.iterate.com/stream/paused", { reason: "maintenance window" });
  const pausedErr = await rejects(() => append("work"), /stream paused: maintenance window/);
  // paused: a plain append is refused with the reason
  expect(pausedErr).toBe("ok");

  const controlOk = await append("events.iterate.com/stream/resumed").then(
    () => true,
    (e: unknown) => String(e),
  );
  // control events pass through a paused stream (resume always works)
  expect(controlOk).toBe(true);

  await append("work"); // resumed: plain appends flow again (a throw here fails the test)

  // ephemerals flow too (they cost no storage; nothing in core meters them)
  const ephOk = await itx.invoke(`itx.append({ type: 'chunk', ephemeral: true })`).then(
    () => true,
    (e: unknown) => String(e).slice(0, 80),
  );
  expect(ephOk).toBe(true);

  // ── observability: the ONE inline address ──
  await itx.rewrite("itx.probe", "itx.whoami"); // a rewrite rule → core.itxExpressionRewriteRules
  await itx.subscribe({ name: "watch", target: "itx.probe", consumes: ["never"] }); // a row → core.subscriptions
  const snap = await itx.invoke("itx.facets.get('core').snapshot()");
  // identity from the birth certificate, incarnation from the wake record, pause from the pair
  expect(snap.state).toMatchObject({ projectId: ctx, path: "/", paused: null });
  expect(typeof snap.state.createdAt).toBe("string");
  expect(snap.state.incarnation).toBeGreaterThanOrEqual(1);
  // the rewrite rules (a MAP by canonical match, both halves parsed) and the subscription rows live
  // in the SAME state — there is no second inline facet
  expect(snap.state.itxExpressionRewriteRules["itx.probe"]).toEqual({
    match: ["itx", "probe"],
    target: ["itx", "whoami"],
  });
  expect(Object.keys(snap.state.subscriptions)).toContain("watch");
  expect(snap.state).not.toHaveProperty("breaker"); // policy left core — it is a facet processor now
  for (const gone of ["rewrite-rules", "subscriptions"]) {
    const err = await itx.invoke(`itx.facets.get('${gone}').snapshot()`).then(
      () => null,
      (e: unknown) => e as { code?: string },
    );
    expect(err?.code).toBe("NO_FACET"); // the core slices have no facet address of their own — plain (absent) names
  }
});
