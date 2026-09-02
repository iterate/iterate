// capability-table-shadow-stack-and-alias-chains.e2e.test.ts — the mount table under stress: 10
// concurrent provides on ONE path end deterministic (newest offset answers) and a concurrent revoke
// sweep restores default-deny; a NON-CANONICAL path spelling is stored CANONICAL and routes; 300
// event-sourced mounts keep both the newest mount and a built-in root under 150ms; an alias chain 30
// deep resolves under the depth-32 budget and 33 deep fails loudly; malformed mount events are
// skipped without wedging later provides.

import { expect, test } from "vitest";
import { append, freshCtx, openItx, rejection } from "./support/client.ts";

const PROVIDED = "events.iterate.com/capability-table/capability-provided";

test("shadow stack: 10 concurrent provides on ONE path end deterministic (newest offset answers), a full concurrent revoke sweep restores default-deny, and the table is not wedged", async () => {
  const itx = openItx(freshCtx("race"));
  // ten distinguishable live capabilities to alias at the contested path (path = identity)
  for (let i = 0; i < 10; i++) {
    await itx.provide(`itx.probe${i}`, () => i);
  }
  const race = () => itx.invokeCapability(["itx", ["race"]]);

  // wave 1: five concurrent provides at itx.race
  const wave1: { providedAtOffset: number }[] = await Promise.all(
    Array.from({ length: 5 }, (_, i) => itx.provide("itx.race", `itx.probe${i}`)),
  );
  const offsets1 = wave1.map((r) => r.providedAtOffset);
  expect(new Set(offsets1).size).toBe(5); // every mount got its own identity
  const winner1 = offsets1.indexOf(Math.max(...offsets1));
  expect(await race()).toBe(winner1); // the newest surviving mount answers

  // wave 2: five MORE provides racing five revokes of wave 1 — full interleave in one gather
  const ops: Promise<any>[] = [];
  for (let i = 0; i < 5; i++) {
    ops.push(itx.provide("itx.race", `itx.probe${5 + i}`));
    ops.push(itx.revoke({ providedAtOffset: offsets1[i] }));
  }
  const results = await Promise.all(ops);
  const offsets2 = results.filter((r) => r && r.providedAtOffset).map((r) => r.providedAtOffset);
  expect(offsets2).toHaveLength(5);
  const winner2 = 5 + offsets2.indexOf(Math.max(...offsets2));
  expect(await race()).toBe(winner2); // wave 1 is fully gone; newest of wave 2 answers

  // the full sweep: revoke everything that remains, concurrently
  await Promise.all(offsets2.map((o) => itx.revoke({ providedAtOffset: o })));
  await expect(race()).rejects.toThrow(/no capability matches/); // default-deny restored

  // and the table is not wedged: a fresh provide works and answers
  const again = await itx.provide("itx.race", "itx.probe7");
  expect(again.providedAtOffset).toBeGreaterThan(Math.max(...offsets2));
  expect(await race()).toBe(7);
});

test("a NON-CANONICAL path spelling through the provide door is stored CANONICAL and routes", async () => {
  // The one-canonicalizer pin: the provide door canonicalizes ONCE at the top, so the reduce stores
  // exactly the path every later door (dispatch, revoke-by-path, the rpcStubs key) compares against
  // — a stray space can never mint a row no route serves. (The DO-door half is pinned in
  // __workers-tests__/do-doors.test.ts, where the raw door is callable.)
  const ctx = freshCtx("canon");
  const itx = openItx(ctx);
  await itx.provide(" itx.ghost", "itx.whoami");
  const snap = await itx.invokeCapability("itx.facets.get('capability-table').snapshot()");
  const row = (snap.state.mounts as { path: string[] }[]).find(
    (m) => m.path.join(".") === "itx.ghost",
  );
  expect(row).toBeDefined(); // stored CANONICAL
  expect(await itx.invokeCapability(["itx", ["ghost"]])).toMatchObject({ projectId: ctx }); // and routed
  await itx.revoke("itx.ghost"); // the canonical spelling is what revoke-by-path finds
  const err = await rejection(itx.invokeCapability(["itx", ["ghost"]]));
  expect(err.message).toContain("no capability matches");
});

test("300 mounts: invoking the NEWEST mount and a built-in root both stay under 150ms", async () => {
  const ctx = freshCtx("mounts300");
  const itx = openItx(ctx);
  // Mounts are event-sourced — append all 300 capability-provided events in ONE commit.
  const mounts = Array.from({ length: 300 }, (_, i) => ({
    type: PROVIDED,
    payload: { path: `itx.m${i}`, target: "itx.whoami" },
  }));
  const committed = await append(itx, ...mounts);
  expect(committed).toHaveLength(300);

  const time = async (fn: () => Promise<unknown>, iters = 12): Promise<number> => {
    const samples: number[] = [];
    for (let i = 0; i < iters; i++) {
      const t0 = performance.now();
      await fn();
      samples.push(performance.now() - t0);
    }
    return [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)]; // median
  };

  // Warm both lanes once (table rehydration / DO wake are not what we are measuring).
  const viaNewest = await itx.invokeCapability(["itx", ["m299"]]);
  expect(viaNewest).toMatchObject({ projectId: ctx, path: "/" }); // it really aliases whoami
  await itx.invokeCapability(["itx", ["whoami"]]);

  const newestMs = await time(() => itx.invokeCapability(["itx", ["m299"]]));
  const rootMs = await time(() => itx.invokeCapability(["itx", ["whoami"]]));
  console.log(
    `[300 mounts] newest-mount median ${newestMs.toFixed(1)}ms, built-in root median ${rootMs.toFixed(1)}ms`,
  );
  expect(newestMs, `newest event mount (m299) median ${newestMs.toFixed(1)}ms`).toBeLessThan(150);
  expect(rootMs, `built-in root (whoami) median ${rootMs.toFixed(1)}ms`).toBeLessThan(150);
}, 90_000);

test("an alias chain 30 deep resolves under the depth-32 budget; 33 deep fails loudly", async () => {
  const ctx = freshCtx("alias");
  const itx = openItx(ctx);
  // alias0 → itx.whoami; aliasK → itx.alias(K-1). One commit mounts all 33 rows.
  const aliases = Array.from({ length: 33 }, (_, i) => ({
    type: PROVIDED,
    payload: { path: `itx.alias${i}`, target: i === 0 ? "itx.whoami" : `itx.alias${i - 1}` },
  }));
  await append(itx, ...aliases);

  // 30 hops (alias29 → … → alias0 → whoami) resolve within the budget…
  const resolved = await itx.invokeCapability(["itx", ["alias29"]]);
  expect(resolved).toMatchObject({ projectId: ctx, path: "/" });

  // …33 hops trip the guard LOUDLY (never a spin, never a stack overflow).
  await expect(itx.invokeCapability(["itx", ["alias32"]])).rejects.toThrow(/depth 32/);
}, 60_000);

test("bad mount events are skipped without wedging later provides", async () => {
  const ctx = freshCtx("badmount");
  const itx = openItx(ctx);
  // an unparseable target — the reduce's own try/catch lane
  await append(itx, { type: PROVIDED, payload: { path: "itx.broken", target: "((((" } });
  // NO payload at all — the destructure lane (caught by the per-event reduce guard)
  await append(itx, { type: PROVIDED });
  // wrong shapes inside the payload
  await append(itx, { type: PROVIDED, payload: { path: 42, target: ["not", "a", "string"] } });
  // the table still takes provides and resolves them — the checkpoint didn't wedge
  const { providedAtOffset } = await itx.provide("itx.hello", "itx.whoami");
  expect(providedAtOffset).toBeGreaterThan(0);
  expect(await itx.invokeCapability(["itx", ["hello"]])).toMatchObject({ projectId: ctx });
  // and the malformed mount is dead weight, not a route (default-deny still answers there)
  const missErr = await rejection(itx.invokeCapability(["itx", ["broken"]]));
  expect(missErr.message).toContain("no capability matches");
});
