// wait.e2e.test.ts — waitForEvent THROUGH THE CAPNWEB EDGE: the wait parks on the DO (session A's
// open call is what keeps it alive), a SECOND session appends the matching event, and the parked
// promise resolves with the committed event. Plus the coded timeout. The park/settle mechanics are
// pinned deterministically in __workers-tests__/stream.test.ts; this file proves the doors — edge
// `Itx.waitForEvent` → DO → Stream — end to end.

import { expect, test } from "vitest";
import { freshCtx, openItx, sleep } from "./support/client.ts";

test("waitForEvent round trip: parked via session A, appended via session B, resolved", async () => {
  const ctx = freshCtx("wait");
  const itxA = openItx(ctx);
  const itxB = openItx(ctx);
  await itxB.invokeCapability(`itx.stream.append({ type: 'seed' })`);
  // Anchor at the CURRENT head explicitly: the wait then resolves whether it parks first or the
  // append lands first (no ordering flake) — while the sleep below makes the parked path the one
  // actually exercised.
  const head = (await itxA.invokeCapability("itx.stream.read(0)")).scannedThroughOffset;
  const pending = itxA.waitForEvent({ type: "ping", afterOffset: head, timeoutMs: 20_000 });
  await sleep(300);
  await itxB.invokeCapability(`itx.stream.append({ type: 'ping', payload: { n: 1 } })`);
  const got = await pending;
  expect(got.type).toBe("ping");
  expect(got.payload).toEqual({ n: 1 });
  expect(got.offset).toBeGreaterThan(head);
});

test("waitForEvent: the timeout crosses the edge as code WAIT_TIMEOUT", async () => {
  const itx = openItx(freshCtx("waitto"));
  const err = await itx.waitForEvent({ type: "never-appended", timeoutMs: 500 }).then(
    () => null,
    (e: unknown) => e as Error & { code?: string },
  );
  expect(err).not.toBeNull();
  expect(err!.code).toBe("WAIT_TIMEOUT"); // the own-property code survives every hop (core/errors.ts)
});
