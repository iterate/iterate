// session-lends-per-context.e2e.test.ts — THE CROSS-CONTEXT LEND PIN. One /api session hands out an
// IterateContext PER CONTEXT, but they all share the session's ONE SessionTeardown (session.ts).
// A capability path is only unique PER CONTEXT (each context DO has its own capability table), so
// the teardown must key by (context, capability) — the round-2 regression keyed by capability path
// alone, and the SECOND context's provide at the same path recalled the FIRST context's stub:
// its pager closed, the first context's DO dropped the stub from its `itx.rpcStubs` registry, and
// a perfectly healthy live mount went CONNECTION_OFFLINE (the mount is data and stays; the stub
// is physical and was gone).
//
// The pin is the reviewer's exact probe: root provides a live fn at `itx.clash`, '/sub' provides a
// DIFFERENT live fn at the SAME capability path, and BOTH stay callable — including after a settle
// delay, because the recall was ASYNC (dispose → pager close → the DO's socket-close handler
// lands moments later; an immediate-only assertion could pass before the transport drops).

import { expect, test } from "vitest";
import { freshCtx, session, sleep } from "./support/client.ts";

test("TWO CONTEXTS of one session provide live fns at the SAME capability path — both stay callable", async () => {
  const ctx = freshCtx("ctxclash");
  const s = session();
  const a = s.authenticate().projects.get(ctx); // the root context ("/")
  const b = a.cd("/sub"); // another context of the project — SAME session, so the SAME SessionTeardown

  await a.provide("itx.clash", (x: number) => x + 1);
  await b.provide("itx.clash", (x: number) => x + 100);

  // Both callable right away (each resolves through its OWN context's live row) …
  expect(await a.invokeCapability("itx.clash(1)")).toBe(2);
  expect(await b.invokeCapability("itx.clash(1)")).toBe(101);

  // … and STILL callable after the settle: with the bug, b's provide had already recalled a's
  // stub, and the resulting pager close drops a's stub from its DO's registry asynchronously —
  // a's mount would still be there, answering CONNECTION_OFFLINE.
  await sleep(2000);
  expect(await a.invokeCapability("itx.clash(1)")).toBe(2); // root's provider survived '/sub''s provide
  expect(await b.invokeCapability("itx.clash(1)")).toBe(101); // and vice versa
});
