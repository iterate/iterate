// stream-wait-for-event.e2e.test.ts — waitForEvent THROUGH ITS DOORS: the wait lives on the DO (the caller's open
// call is what keeps it alive), a SECOND session appends the matching event, and the waiting
// promise resolves with the committed event. Plus the coded timeout. The wait/settle mechanics are
// pinned deterministically in __workers-tests__/stream.test.ts; this file proves the doors end to
// end — the capnweb edge (`itx.waitForEvent`, a built-in root riding `invoke` → DO → Stream) AND
// the loaded-worker lane (`env.ITX.waitForEvent` → ItxEntrypoint → DO → Stream).

import { expect, test } from "vitest";
import { freshCtx, openItx, sleep } from "./support/client.ts";

test("waitForEvent round trip: awaited via session A, appended via session B, resolved", async () => {
  const ctx = freshCtx("wait");
  const itxA = openItx(ctx);
  const itxB = openItx(ctx);
  await itxB.invoke(`itx.append({ type: 'seed' })`);
  // Anchor at the CURRENT head explicitly: the wait then resolves whether it registers first or the
  // append lands first (no ordering flake) — while the sleep below makes the waiting path the one
  // actually exercised.
  const head = (await itxA.invoke("itx.read(0)")).scannedThroughOffset;
  const pending = itxA.waitForEvent({ type: "ping", afterOffset: head, timeoutMs: 20_000 });
  await sleep(300);
  await itxB.invoke(`itx.append({ type: 'ping', payload: { n: 1 } })`);
  const got = await pending;
  expect(got.type).toBe("ping");
  expect(got.payload).toEqual({ n: 1 });
  expect(got.offset).toBeGreaterThan(head);
});

test("waitForEvent through a LOADED worker's env.ITX — the ItxEntrypoint door waits on the DO and returns the event", async () => {
  const ctx = freshCtx("waitload");
  const itxA = openItx(ctx);
  const itxB = openItx(ctx);
  // The door under test is `env.ITX.waitForEvent` — the ItxEntrypoint's OWN stream verb (the
  // Workers-RPC lane no other suite drives), not the itx scope behind `env.ITX.get()`. A runScript
  // lambda only ever sees the scope, so a real entrypoint is loaded: its `run` opens the wait
  // through env.ITX, a second session appends, and the loaded worker returns the committed event.
  await itxA.invoke([
    "itx",
    "kv",
    [
      "put",
      "src/waiter.js",
      `import { WorkerEntrypoint } from "cloudflare:workers";
export default class Waiter extends WorkerEntrypoint {
  async run(afterOffset) {
    return await this.env.ITX.waitForEvent({ type: "ping", afterOffset, timeoutMs: 20000 });
  }
}`,
    ],
  ]);
  const head = (await itxA.invoke("itx.read(0)")).scannedThroughOffset;
  const pending = itxA.invoke(
    `itx.load("itx.kv.get('src/waiter.js')").getEntrypoint().run(${head})`,
  );
  await sleep(500); // let the loaded worker start waiting before the append (the anchored afterOffset makes either order correct)
  await itxB.invoke(`itx.append({ type: 'ping', payload: { via: 'entrypoint' } })`);
  const got = await pending;
  expect(got.type).toBe("ping");
  expect(got.payload).toEqual({ via: "entrypoint" });
  expect(got.offset).toBeGreaterThan(head);
});

test("waitForEvent: the timeout crosses the edge as code WAIT_TIMEOUT", async () => {
  const itx = openItx(freshCtx("waitto"));
  const err = await itx.waitForEvent({ type: "never-appended", timeoutMs: 500 }).then(
    () => null,
    (e: unknown) => e as Error & { code?: string },
  );
  expect(err).not.toBeNull();
  expect(err!.code).toBe("WAIT_TIMEOUT"); // the own-property code survives every hop (lib/errors.ts)
});
