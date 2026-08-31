// core.e2e.test.ts — THE CORE PROCESSOR live: the stream's operational truth folded INLINE at
// the commit point (the apps/os shape). Control is ordinary events; enforcement is the parent
// reading the fold. Proves: pause refuses appends (control passes), resume heals, the token-
// bucket breaker trips on the (N+1)th durable append and refills by wall time, breaker-off
// restores unlimited, and hostState() exposes the core truth.
// (was proofs/prove_core.mjs)

import { expect, test } from "vitest";
import { freshCtx, openItx, sleep } from "./support/client.ts";

test("core fold: pause/resume, token-bucket breaker, ephemeral bypass, hostState observability", async () => {
  const itx = openItx(freshCtx("core"));

  const append = (type: string, payload?: Record<string, unknown>): Promise<unknown> =>
    itx.invokeCapability(
      `itx.stream.append(${JSON.stringify({ type, ...(payload && { payload }) })})`,
    );
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

  // ── circuit breaker ──
  await append("events.iterate.com/stream/breaker-configured", {
    capacity: 3,
    refillPerSecond: 0.5,
  });
  let tripped: number | string | null = null;
  let admitted = 0;
  for (let i = 0; i < 6; i++) {
    const r = await rejects(() => append("burst"), /circuit breaker open/);
    if (r === "ok") {
      tripped = i;
      break;
    }
    if (r === null) admitted++;
    else {
      tripped = `wrong error: ${r}`;
      break;
    }
  }
  // breaker admits exactly its capacity (3) then trips on the 4th
  expect(tripped).toBe(3);
  expect(admitted).toBe(3);

  // refill: 0.5 tokens/s → one token back after ~2s
  await sleep(2600);
  const afterRefill = await rejects(() => append("burst"), /circuit breaker open/);
  // the bucket refills by wall time — one more append admitted after ~2.6s
  expect(afterRefill).toBe(null);
  const immediatelyAgain = await rejects(() => append("burst"), /circuit breaker open/);
  // and the very next append trips again (the refill was one token)
  expect(immediatelyAgain).toBe("ok");

  // ephemeral events are never counted (they cost no storage)
  // placeholder no-op from the proof — a durable append the empty bucket rejects (kept for fidelity)
  await rejects(() => append("chunk-ish"), /x/).catch(() => null);
  const ephOk = await itx
    .invokeCapability(`itx.stream.append({ type: 'chunk', ephemeral: true })`)
    .then(
      () => true,
      (e: unknown) => String(e).slice(0, 80),
    );
  // ephemeral appends bypass the breaker (durable growth is what it meters)
  expect(ephOk).toBe(true);

  // breaker off
  await append("events.iterate.com/stream/breaker-configured", {});
  for (let i = 0; i < 5; i++) await append("free");
  // empty configure turns the breaker off — 5 rapid appends admitted (a throw here fails the test)

  // ── observability ──
  const hostState = await itx.hostState();
  // hostState exposes the core fold (unpaused, breaker off)
  expect(hostState.core).toBeTruthy();
  expect(hostState.core.paused).toBe(null);
  expect(hostState.core.breaker).toBe(null);
});
