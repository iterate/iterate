// session-lends-per-context.e2e.test.ts — THE CROSS-CONTEXT LEND PIN. One /api session hands out an
// IterateContext PER CONTEXT, but they all share the session's ONE ContextLeaseBook (session.ts).
// An rpc-stub key is only unique PER CONTEXT (each context DO has its own `itx.rpcStubs` registry
// and its own rewrite-rule table), so the teardown must key by (context, rpcStubKey) — the round-2
// regression keyed by the key alone, and the SECOND context's provide at the same key recalled the
// FIRST context's stub: its pager closed, the first context's DO dropped the stub from its
// `itx.rpcStubs` registry, and a perfectly healthy rewrite rule went RPC_STUB_OFFLINE (the rule is
// data; the stub is physical and was gone).
//
// The pin is the reviewer's exact probe: root provides a live fn under `itx.clash`, '/sub' provides a
// DIFFERENT live fn under the SAME key, and BOTH stay callable — including after a settle delay,
// because the recall was ASYNC (dispose → pager close → the DO's socket-close handler lands moments
// later; an immediate-only assertion could pass before the transport drops).

import { expect, test } from "vitest";
import { freshCtx, session, sleep } from "./support/client.ts";

test("TWO CONTEXTS of one session provide live fns under the SAME rpc-stub key — both stay callable", async () => {
  const ctx = freshCtx("ctxclash");
  const s = session();
  const a = s.authenticate().projects.get(ctx); // the root context ("/")
  const b = a.cd("/sub"); // another context of the project — SAME session, so the SAME ContextLeaseBook

  await a.provide("itx.clash", (x: number) => x + 1);
  await b.provide("itx.clash", (x: number) => x + 100);

  // Both callable right away (each resolves through its OWN context's rule and registry) …
  expect(await a.invoke("itx.clash(1)")).toBe(2);
  expect(await b.invoke("itx.clash(1)")).toBe(101);

  // … and STILL callable after the settle: with the bug, b's provide had already recalled a's
  // stub, and the resulting pager close drops a's stub from its DO's registry asynchronously —
  // a's rule would still be there, answering RPC_STUB_OFFLINE.
  await sleep(2000);
  expect(await a.invoke("itx.clash(1)")).toBe(2); // root's provider survived '/sub''s provide
  expect(await b.invoke("itx.clash(1)")).toBe(101); // and vice versa
});

test("a stale live provide handle cannot remove its expression successor", async () => {
  const itx = session().authenticate().projects.get(freshCtx("provide-replaced"));
  const stale = await itx.provide("itx.alias", (value: string) => `old:${value}`);

  await itx.provide("itx.alias", "itx.kv");
  stale[Symbol.dispose]();
  await sleep(800);

  // The live pager was recalled, but its old handle has no durable undo to apply to the expression.
  expect(await itx.invoke("itx.alias.get('missing')")).toBeNull();
  expect((await itx.rewriteRules.get("itx.alias"))?.target).toBe("itx.kv");
});

test("a stale session teardown cannot clear a replacement live subscription", async () => {
  const ctx = freshCtx("subscription-reconnect");
  const observer = session().authenticate().projects.get(ctx);
  const oldSession = session();
  await oldSession
    .authenticate()
    .projects.get(ctx)
    .subscribe({
      name: "reconnect",
      target: () => undefined,
    });

  const replacementSession = session();
  await replacementSession
    .authenticate()
    .projects.get(ctx)
    .subscribe({
      name: "reconnect",
      target: () => undefined,
    });
  oldSession[Symbol.dispose]();
  await sleep(800);

  expect((await observer.subscriptions.get("reconnect"))?.target).toBe(
    "itx.builtins.rpcStubs.get('subscription:reconnect')",
  );
  expect(await observer.rpcStubs.list()).toContain("subscription:reconnect");
});
