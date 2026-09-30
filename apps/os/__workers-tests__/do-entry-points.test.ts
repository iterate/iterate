// __workers-tests__/do-entry-points.test.ts — the IterateContextDurableObject's Workers-RPC entry points,
// pinned at zero distance (the Workers suite is the only one that can BOTH call the DO verbs raw —
// no capnweb edge reducing the returns away — AND inspect the DO's own storage via
// runInDurableObject). The DO has exactly these entry points: the STREAM (`append`, `read` — a wait is
// the built-in `itx.waitForEvent`, through `invoke`), the ONE dispatch method (`invoke`), native `fetch` (the pager upgrade, the
// fetch-upgrade leg, the itx-expression fetch, egress) and the rpc-stub plumbing
// (`lendRpcStub`, `rpcStubTransportState`; the pager attach IS the upgrade). There are NO configuration
// verbs: every change to a context is an appended event, so a Workers-RPC caller configures a
// rewrite rule exactly as the edge's `provide` does — a LITERAL `append({ type:
// "events.iterate.com/itx/rewrite-rule-configured", payload: { match, target } })` — and a subscription
// with `append({ type: "events.iterate.com/itx/subscription-configured", payload: … })`. The DO's
// append boundary (stream/core-processor.ts `normalizeControlEvent`) validates + canonicalizes the
// literal; no event-builder helper stands between the caller and the event. The pins:
//
//   • the alarm serves durable obligations only: a probe (`itx.facets.get('core').snapshot()`) on a
//     never-touched ctx MATERIALIZES it (its first handler's `Stream.appendWakeRecord()` writes
//     created + woken before the first request is served) yet OWES no alarm (support.ts
//     `owedAlarm`) — a pin (a borrowed rpc stub, an open socket) is
//     released by a timer, never the alarm; only storage.getAlarm() can see that (the deployed e2e
//     tests pin the records but cannot read the alarm);
//   • the entry points themselves: the rewrite-rule EVENT's match is canonicalized at the append
//     BOUNDARY (a Workers-RPC caller bypasses the edge, appends a literal, and the DO normalizes
//     it — no builder in between); and a table row is `{ match, target }` keyed by the canonical
//     match and NOTHING else — no delivery mode, no offset identity (HOW a target is served is never
//     written on a rule: the delivery loop decides by evaluating a subscription's own target,
//     subscription-delivery.ts);
//   • the table is a MAP: a re-set at the same match REPLACES (nothing is "beneath"), `null`
//     DELETES, a second `null` is a benign no-op — and every set or un-set is exactly ONE event,
//     never deduped against the current row;
//   • un-setting a rule is pure data and never touches a transport: the lent stub stays in
//     `itx.rpcStubs` (its pager socket in the census), reachable THROUGH the registry, while the
//     un-set match answers NO_ITX_EXPRESSION_MATCH; disposing the provide HANDLE is the other half
//     — it recalls the stub (presence shrinks) AND un-sets the rule it was provided with.

import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { RpcTarget } from "capnweb";
import { expect, test } from "vitest";
import { parse, print, type ItxExpression } from "iterate/expression";
import {
  adminCredentials,
  openSession,
  owedAlarm,
  readLog,
  releasePins,
  snapshot,
  stub,
  until,
} from "./support.ts";

test("a core-snapshot probe materializes only created and woken, without subscriptions or an alarm", async () => {
  await runInDurableObject(stub("prj_do_virginprobe"), async (instance, state) => {
    const snap = (await instance.invoke("itx.facets.get('core').snapshot()")) as {
      offset: number;
      state: { projectId?: string; path?: string; createdAt?: string; incarnation?: number };
    };
    expect(snap).toMatchObject({
      offset: 2, // created and woken
      state: {
        projectId: "prj_do_virginprobe",
        path: "/",
        createdAt: expect.any(String),
        incarnation: 1,
      },
    });
    // Nothing is subscribed, so there is no delivery to schedule.
    await until(
      "no alarm after the probe",
      async () => owedAlarm(await state.storage.getAlarm()) === null,
    );
    expect((await instance.read(0)).events.map((e) => [e.type, e.offset])).toEqual([
      ["events.iterate.com/itx/created", 1],
      ["events.iterate.com/itx/woken", 2],
    ]);
    expect(
      Number(
        state.storage.sql.exec("SELECT value FROM stream_meta WHERE key = 'incarnation'").one()
          .value,
      ),
    ).toBe(1);
    // A plain append follows created and woken.
    const [mark] = (await instance.append({ type: "mark" })) as unknown as { offset: number }[];
    expect(mark).toMatchObject({ offset: 3 });
    // With no subscriptions, the mark creates no delivery claim.
    await until(
      "no alarm after the ack",
      async () => owedAlarm(await state.storage.getAlarm()) === null,
    );
  });
});

test("a pre-v18 core row refuses normal access yet remains sweepable and destroyable", async () => {
  const context = "prj_do_legacy_core_contract";
  const s = stub(context);
  const [seed] = (await s.append({ type: "seed" })) as unknown as [{ offset: number }];
  await runInDurableObject(s, async (_instance, state) => {
    state.storage.sql.exec(
      "UPDATE events SET body = ? WHERE offset = ?",
      JSON.stringify({
        type: "events.iterate.com/itx/subscription-configured",
        payload: { name: "legacy", target: "itx.worker.processEventBatch" },
        ephemeral: false,
      }),
      seed.offset,
    );
    state.storage.sql.exec(
      "UPDATE reduce_checkpoints SET reducer_version = '17.0.0' WHERE slug = 'core'",
    );
  });
  await evictDurableObject(s);
  await runInDurableObject(s, async (instance) => {
    // Workerd exposes even in-actor DO entry points as native RPC promises; await the refusal so
    // its expected INVALID_INPUT is not reported later as an unhandled test rejection.
    expect(await rejected(instance.read(0))).toMatchObject({
      message: expect.stringMatching(/cannot be reconstructed.*recreate the context/),
    });
    expect(instance.readForSweep(0).events).toContainEqual(
      expect.objectContaining({
        offset: seed.offset,
        type: "events.iterate.com/itx/subscription-configured",
      }),
    );
  });
  await (s.destroy() as Promise<void>).catch(() => undefined); // the reset is the successful erase
});

test("the DO's entry points are the stream, invoke, fetch and the rpc-stub plumbing; a rewrite rule is ONE appended event the append boundary canonicalizes, and a table row is `{ match, target }`, nothing else", async () => {
  const ctx = "prj_do_canonical";
  await runInDurableObject(stub(ctx), async (instance) => {
    const methods = instance as unknown as Record<string, unknown>;
    for (const method of [
      "append",
      "read",
      "invoke",
      "fetch",
      "lendRpcStub",
      "rpcStubTransportState",
    ])
      expect(typeof methods[method]).toBe("function");
  });
  // A Workers-RPC caller bypasses the edge, so the EVENT BUILDER must canonicalize on its own: a
  // non-canonical spelling (leading whitespace) lands the CANONICAL match with the target verbatim.
  // And the row carries no third kind of field — nothing about HOW a target is served is on a rule
  // (a live stub's rule is pure data naming the `itx.rpcStubs` registry; a subscription is its own
  // layer's event, not a rule).
  await stub(ctx).append({
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload: { match: " itx.aliased.ghost", target: "itx.rpcStubs.get('itx.aliased.ghost')" },
  });
  const rules = await rewriteRulesOf(ctx);
  expect(Object.keys(rules)).toEqual(["itx.aliased.ghost"]); // keyed by the canonical match
  const row = rules["itx.aliased.ghost"]!;
  expect(print(row.match)).toBe("itx.aliased.ghost"); // stored CANONICAL — the one-canonicalizer rule
  expect(print(row.target)).toBe("itx.rpcStubs.get('itx.aliased.ghost')"); // the target, verbatim
  expect(Object.keys(row).sort()).toEqual(["match", "target"]); // and nothing else
});

test("the private durable-subscription bridge accepts no target, event, caller or delivery authority from its facet", async () => {
  const context = "prj_do_delivery_bridge";
  const s = stub(context);
  const [configured] = (await s.append({
    type: "events.iterate.com/itx/subscription-configured",
    payload: { name: "sink", target: "itx.whoami", delivery: "durable", consumes: ["never"] },
  })) as unknown as [{ offset: number }];
  const [source] = (await s.append({ type: "never", payload: { real: true } })) as unknown as [
    { offset: number },
  ];
  await runInDurableObject(s, async (instance) => {
    expect(
      await rejected(
        instance.deliverConfiguredSubscription({
          name: "sink",
          configuredAtOffset: configured.offset,
          range: { after: configured.offset, through: source.offset },
          target: "itx.attacker",
          offsets: [source.offset],
          event: { type: "forged", offset: source.offset },
          caller: { delivery: "forged" },
        }),
      ),
    ).toMatchObject({ code: "INVALID_INPUT" });
    expect(
      await rejected(
        instance.deliverConfiguredSubscription({
          name: "sink",
          configuredAtOffset: configured.offset,
          range: { after: configured.offset, through: source.offset },
          // The facet cannot omit the locally selected durable event to alter target input.
          offsets: [],
        }),
      ),
    ).toMatchObject({ code: "GONE" });
  });
});

test("a settled native delivery failure does not suppress the next same-range target call", async () => {
  const context = "prj_do_delivery_failure_retry";
  const s = stub(context);
  await s.append({
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload: { match: "itx.deliveryAlias", target: "itx.missing" },
  });
  const [configured] = (await s.append({
    type: "events.iterate.com/itx/subscription-configured",
    payload: {
      name: "retry",
      target: "itx.deliveryAlias",
      delivery: "durable",
      consumes: ["retry-mark"],
      // Keep automatic catch-up beyond this range so only the two explicit native calls run.
      afterOffset: 1_000_000,
    },
  })) as unknown as [{ offset: number }];
  const [mark] = (await s.append({ type: "retry-mark" })) as unknown as [{ offset: number }];
  const request = {
    name: "retry",
    configuredAtOffset: configured.offset,
    range: { after: configured.offset, through: mark.offset },
    offsets: [mark.offset],
  };
  await runInDurableObject(s, async (instance) => {
    expect(await rejected(instance.deliverConfiguredSubscription(request))).toMatchObject({
      code: "NOT_A_METHOD",
    });
  });
  await s.append({
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload: { match: "itx.deliveryAlias", target: "itx.whoami" },
  });
  await runInDurableObject(s, async (instance) => {
    await expect(instance.deliverConfiguredSubscription(request)).resolves.toBeUndefined();
  });
  await releasePins(context);
});

test("a durable alias ending in a hosted processor method preserves the constrained platform batch route", async () => {
  const context = "prj_do_durable_alias_processor";
  const s = stub(context);
  await s.append({
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload: {
      match: "itx.alias",
      target: ["itx", "facets", ["get", "project"], "processEventBatch"],
    },
  });
  await s.append({
    type: "events.iterate.com/itx/subscription-configured",
    payload: { name: "aliased", target: "itx.alias", delivery: "durable", consumes: ["mark"] },
  });
  const [mark] = (await s.append({ type: "mark" })) as unknown as [{ offset: number }];
  await until(
    "the aliased hosted processor receives its durable batch through the platform route",
    async () => {
      const rows = (await s.invoke("itx.subscriptions.list()")) as Array<{
        name: string;
        cursor?: { confirmedOffset: number };
      }>;
      return rows.find((row) => row.name === "aliased")?.cursor?.confirmedOffset === mark.offset;
    },
  );
  await releasePins(context);
});

test("a fan-out terminal is one idempotent failed receipt, and stale terminals cannot mutate a replacement or resumed row", async () => {
  const context = "prj_do_subscription_terminal_fences";
  const s = stub(context);
  const [configured] = (await s.append({
    type: "events.iterate.com/itx/subscription-configured",
    payload: {
      name: "fanout",
      target: "itx.platformHook.deliverEvent",
      delivery: "durable",
      ordered: false,
      consumes: ["mark"],
    },
  })) as unknown as [{ offset: number }];
  const [mark] = (await s.append({ type: "mark" })) as unknown as [{ offset: number }];
  await runInDurableObject(s, async (instance) => {
    await instance.recordConfiguredSubscriptionTerminal({
      name: "fanout",
      configuredAtOffset: configured.offset,
      afterOffset: mark.offset - 1,
      attempts: 15,
      error: "receiver refused",
      fanOut: true,
    });
    await instance.recordConfiguredSubscriptionTerminal({
      name: "fanout",
      configuredAtOffset: configured.offset,
      afterOffset: mark.offset - 1,
      attempts: 15,
      error: "receiver refused",
      fanOut: true,
    });
  });
  // Raw `read()` and `invoke()` carry event payloads as `unknown`, so Workers-RPC correctly
  // types their unbounded result as `never`. `readLog` is the suite's explicit wire boundary.
  const receipts = (await readLog(context)).filter(
    (event) => event.type === "events.iterate.com/itx/subscription-delivery-failed",
  );
  expect(receipts).toHaveLength(1);
  expect(receipts[0]).toMatchObject({
    payload: { name: "fanout", offset: mark.offset, attempts: 15, error: "receiver refused" },
  });
  expect(
    ((await s.invoke("itx.subscriptions.list()")) as Array<{ name: string }>).find(
      (row: { name: string }) => row.name === "fanout",
    ),
  ).not.toHaveProperty("halted");

  const [replacement] = (await s.append({
    type: "events.iterate.com/itx/subscription-configured",
    payload: { name: "fanout", target: "itx.whoami", delivery: "durable", consumes: ["mark"] },
  })) as unknown as [{ offset: number }];
  await runInDurableObject(s, async (instance) => {
    expect(
      await rejected(
        instance.recordConfiguredSubscriptionTerminal({
          name: "fanout",
          configuredAtOffset: configured.offset,
          afterOffset: mark.offset - 1,
          attempts: 15,
          error: "late predecessor",
          fanOut: true,
        }),
      ),
    ).toMatchObject({ code: "GONE" });
  });
  expect(
    (
      (await s.invoke("itx.subscriptions.list()")) as Array<{
        name: string;
        configuredAtOffset: number;
      }>
    ).find((row: { name: string }) => row.name === "fanout"),
  ).toMatchObject({ configuredAtOffset: replacement.offset });

  await s.append({
    type: "events.iterate.com/itx/subscription-delivery-resumed",
    payload: { name: "fanout", afterOffset: mark.offset },
  });
  await runInDurableObject(s, async (instance) => {
    expect(
      await rejected(
        instance.recordConfiguredSubscriptionTerminal({
          name: "fanout",
          configuredAtOffset: replacement.offset,
          afterOffset: mark.offset,
          attempts: 15,
          error: "late before resume",
        }),
      ),
    ).toMatchObject({ code: "GONE" });
  });
  await releasePins(context);
});

test("an ordered terminal receipt lands outside the control boundary and a resume permits its next terminal receipt", async () => {
  const context = "prj_do_ordered_terminal_receipts";
  const s = stub(context);
  const [configured] = (await s.append({
    type: "events.iterate.com/itx/subscription-configured",
    payload: { name: "ordered", target: "itx.missing", delivery: "durable", consumes: ["mark"] },
  })) as unknown as [{ offset: number }];
  const [mark] = (await s.append({ type: "mark" })) as unknown as [{ offset: number }];
  const terminal = (resumeAtOffset?: number) =>
    runInDurableObject(s, (instance) =>
      instance.recordConfiguredSubscriptionTerminal({
        name: "ordered",
        configuredAtOffset: configured.offset,
        afterOffset: mark.offset - 1,
        attempts: 15,
        error: "missing target",
        resumeAtOffset,
      }),
    );
  await terminal();
  const [resumed] = (await s.append({
    type: "events.iterate.com/itx/subscription-delivery-resumed",
    payload: { name: "ordered", afterOffset: mark.offset - 1 },
  })) as unknown as [{ offset: number }];
  await terminal(resumed.offset);
  expect(
    (await readLog(context)).filter(
      (event) => event.type === "events.iterate.com/itx/subscription-delivery-halted",
    ),
  ).toHaveLength(2);
  expect(
    (
      (await s.invoke("itx.subscriptions.list()")) as Array<{
        name: string;
        halted?: { afterOffset: number; attempts: number };
      }>
    ).find((row: { name: string }) => row.name === "ordered"),
  ).toMatchObject({
    halted: { afterOffset: mark.offset - 1, attempts: 15 },
  });
  await releasePins(context);
});

test("a halted durable row resumes through the runner under its new resume generation", async () => {
  const context = "prj_do_subscription_resume_bridge";
  const s = stub(context);
  const [configured] = (await s.append({
    type: "events.iterate.com/itx/subscription-configured",
    payload: {
      name: "ordered",
      target: "itx.whoami",
      delivery: "durable",
      consumes: ["mark"],
    },
  })) as unknown as [{ offset: number }];
  const [first] = (await s.append({ type: "mark" })) as unknown as [{ offset: number }];
  await until("the first durable delivery is confirmed", async () => {
    const rows = (await s.invoke("itx.subscriptions.list()")) as Array<{
      name: string;
      cursor?: { confirmedOffset: number };
    }>;
    return rows.find((row) => row.name === "ordered")?.cursor?.confirmedOffset === first.offset;
  });
  await runInDurableObject(s, (instance) =>
    instance.recordConfiguredSubscriptionTerminal({
      name: "ordered",
      configuredAtOffset: configured.offset,
      afterOffset: first.offset - 1,
      attempts: 25,
      error: "test halt",
    }),
  );
  await s.append({
    type: "events.iterate.com/itx/subscription-delivery-resumed",
    payload: { name: "ordered", afterOffset: first.offset },
  });
  const [second] = (await s.append({ type: "mark" })) as unknown as [{ offset: number }];
  await until("the resumed generation confirms a later durable delivery", async () => {
    const rows = (await s.invoke("itx.subscriptions.list()")) as Array<{
      name: string;
      cursor?: { confirmedOffset: number };
    }>;
    return rows.find((row) => row.name === "ordered")?.cursor?.confirmedOffset === second.offset;
  });
  await releasePins(context);
});

test("the private subscriptions facet owns ordered and fan-out durable progress", async () => {
  const context = "prj_do_subscription_facet";
  const s = stub(context);
  await s.append({
    type: "events.iterate.com/itx/subscription-configured",
    payload: { name: "ordered", target: "itx.whoami", delivery: "durable", consumes: ["mark"] },
  });
  await s.append({
    type: "events.iterate.com/itx/subscription-configured",
    payload: {
      name: "fanout",
      target: "itx.platformHook.deliverEvent",
      delivery: "durable",
      ordered: false,
      consumes: ["mark"],
    },
  });
  const [mark] = (await s.append({ type: "mark" })) as unknown as [{ offset: number }];
  await until("the subscriptions facet acknowledges both delivery shapes", async () => {
    const rows = (await s.invoke("itx.subscriptions.list()")) as {
      name: string;
      cursor?: { confirmedOffset: number };
      pending?: number;
    }[];
    const ordered = rows.find((row) => row.name === "ordered");
    const fanout = rows.find((row) => row.name === "fanout");
    return (
      ordered?.cursor?.confirmedOffset === mark.offset &&
      fanout?.cursor?.confirmedOffset === mark.offset &&
      fanout.pending === 0
    );
  });
  await releasePins(context);
});

test("the rule table is a MAP: a re-set at the same match REPLACES (one row, nothing beneath), `null` DELETES, a second `null` is a benign no-op — and every set or un-set is exactly ONE event, never deduped", async () => {
  const ctx = "prj_do_map";
  const s = stub(ctx);
  await s.append({
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload: { match: "itx.alias", target: "itx.whoami" },
  });
  expect(await s.invoke("itx.alias()")).toEqual({ projectId: ctx, path: "/" });
  // The same match set again: the row is replaced in place — one key, the new target, no stack.
  await s.append({
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload: { match: "itx.alias", target: "itx.rpcStubs.list" },
  });
  expect(await s.invoke("itx.alias()")).toEqual([]);
  expect(Object.keys(await rewriteRulesOf(ctx))).toEqual(["itx.alias"]);
  expect(await rewriteRuleEventCount(ctx)).toBe(2); // one event per set — no dedupe against the current row
  // `null` deletes; nothing is "restored from beneath" — the first target went with the replace.
  await s.append({
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload: { match: "itx.alias", target: null },
  });
  expect(await rewriteRulesOf(ctx)).toEqual({});
  // A second `null` lands as a row (the log is the log) and changes nothing — the reduce's no-op.
  await s.append({
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload: { match: "itx.alias", target: null },
  });
  expect(await rewriteRulesOf(ctx)).toEqual({});
  expect(await rewriteRuleEventCount(ctx)).toBe(4);
});

test("a live provide shadows a same-named durable rule without writing one, and a durable unset cannot revoke its attached capability", async () => {
  const ctx = "prj_do_unsetlive";
  const s = stub(ctx);
  // A physical pager attachment shadows this name in memory. Its capability is not written into
  // the durable rewrite table, so a raw durable unset cannot revoke the live attachment.
  const itx = await (await openSession()).authenticate(adminCredentials()).projects.get(ctx);
  const provided = await itx.provide("itx.livecap", new Alive());
  expect(typeof provided[Symbol.dispose]).toBe("function"); // a DISPOSABLE handle — no offsets, no identities
  expect(await s.invoke("itx.livecap.ping()")).toBe("alive");
  const rpcStubPagersBefore = await rpcStubPagersOf(ctx);
  expect(rpcStubPagersBefore).toBe(1);

  // A durable unset changes only the underlying table. The attachment still wins until its pager
  // detaches; it neither creates nor depends on a durable rule.
  await s.append({
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload: { match: "itx.livecap", target: null },
  });
  expect(await rpcStubPagersOf(ctx)).toBe(rpcStubPagersBefore);
  expect(await s.invoke("itx.rpcStubs.list()")).toEqual(["itx.livecap"]);
  expect(await itx.invoke("itx.livecap.ping()")).toBe("alive");
  expect("itx.livecap" in (await rewriteRulesOf(ctx))).toBe(false);
  expect(await s.invoke("itx.rpcStubs.get('itx.livecap').ping()")).toBe("alive");

  // A durable rule can be installed beneath the live overlay, ready for after detach.
  await s.append({
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload: { match: "itx.livecap", target: "itx.rpcStubs.get('itx.livecap')" },
  });
  expect(await itx.invoke("itx.livecap.ping()")).toBe("alive");
});

test("disposing a live provide recalls its pager and reveals no durable row it never wrote", async () => {
  const ctx = "prj_do_disposehandle";
  const s = stub(ctx);
  const itx = await (await openSession()).authenticate(adminCredentials()).projects.get(ctx);
  const provided = await itx.provide("itx.doomed", new Alive());
  expect(await s.invoke("itx.doomed.ping()")).toBe("alive");
  expect(Object.keys(await rewriteRulesOf(ctx))).toEqual([]);
  expect(await rpcStubPagersOf(ctx)).toBe(1);

  provided[Symbol.dispose](); // the client lets go: capnweb releases the export, the edge recalls
  await until("the pager left the census", async () => (await rpcStubPagersOf(ctx)) === 0);
  expect("itx.doomed" in (await rewriteRulesOf(ctx))).toBe(false);
  expect(await s.invoke("itx.rpcStubs.list()")).toEqual([]); // presence shrank
  expect(await deniedCode(itx, "itx.doomed.ping()")).toBe("NO_ITX_EXPRESSION_MATCH");
});

test("a PAUSED context survives an eviction: the constructor's birth-row replay is admitted while paused, so the next incarnation can take the resume (BORN RED: the pause check ran before the idempotency lookup, and a paused context could never be rebuilt)", async () => {
  const ctx = "prj_do_paused_evict";
  const s = stub(ctx);
  await s.append({ type: "events.iterate.com/itx/paused", payload: { reason: "operator" } });
  await evictDurableObject(s);
  // The fresh incarnation's constructor replays `config` under its idempotency key — on a paused
  // stream. Then the resume lands like any other day.
  await stub(ctx).append({ type: "events.iterate.com/itx/resumed" });
  expect((await readLog(ctx)).map((e) => e.type)).toContain("events.iterate.com/itx/resumed");
  const [afterResume] = (await stub(ctx).append({ type: "after-resume" })) as unknown as {
    type: string;
  }[];
  expect(afterResume).toMatchObject({ type: "after-resume" });
});

test("a handle's undo is a COMPARE-AND-SET decided in the reduce: a stale removal (naming the target or the offset the handle wrote) is a no-op against a replacement — there is no read-then-append window", async () => {
  const ctx = "prj_do_undo_cas";
  const s = stub(ctx);
  // RULES: session A's row, replaced by session B's; A's undo names A's target and changes nothing.
  await s.append({
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload: { match: "itx.x", target: "itx.tab1" },
  });
  await s.append({
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload: { match: "itx.x", target: "itx.tab2" },
  });
  await s.append({
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload: { match: "itx.x", target: null, ifTarget: parse("itx.tab1") },
  });
  expect(print((await rewriteRulesOf(ctx))["itx.x"].target)).toBe("itx.tab2");
  await s.append({
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload: { match: "itx.x", target: null, ifTarget: parse("itx.tab2") },
  }); // B's own undo
  expect((await rewriteRulesOf(ctx))["itx.x"]).toBeUndefined();
  // SUBSCRIPTIONS: the row's identity is its configure offset.
  const [first] = (await s.append({
    type: "events.iterate.com/itx/subscription-configured",
    payload: { name: "digest", target: "itx.digest.processEventBatch", delivery: "durable" },
  })) as unknown as { offset: number }[];
  const [second] = (await s.append({
    type: "events.iterate.com/itx/subscription-configured",
    payload: { name: "digest", target: "itx.digest.processEventBatch", delivery: "durable" },
  })) as unknown as { offset: number }[];
  const row = async () =>
    (await s.invoke("itx.subscriptions.get('digest')")) as { configuredAtOffset: number } | null;
  await s.append({
    type: "events.iterate.com/itx/subscription-configured",
    payload: {
      name: "digest",
      target: null,
      ifConfiguredAtOffset: first.offset,
    },
  });
  expect((await row())?.configuredAtOffset).toBe(second.offset); // the replacement stands
  await s.append({
    type: "events.iterate.com/itx/subscription-configured",
    payload: {
      name: "digest",
      target: null,
      ifConfiguredAtOffset: second.offset,
    },
  });
  expect(await row()).toBeNull();
});

/** One rewrite-rule row as the core snapshot serializes it (the rules are `core` state — a RECORD
 *  by canonical match; both halves are the parsed ItxExpression, so `print` them to compare against
 *  the strings the event was built from). */
type RewriteRuleRow = { match: ItxExpression; target: ItxExpression };
async function rewriteRulesOf(ctx: string): Promise<Record<string, RewriteRuleRow>> {
  return (
    await snapshot<{ itxExpressionRewriteRules: Record<string, RewriteRuleRow> }>(ctx, "core")
  ).state.itxExpressionRewriteRules;
}

/** The `itx/rewrite-rule-configured` rows of the durable log — one per set or un-set, no dedupe. */
async function rewriteRuleEventCount(ctx: string): Promise<number> {
  return (await readLog(ctx)).filter(
    (e) => e.type === "events.iterate.com/itx/rewrite-rule-configured",
  ).length;
}

/** The DO's in-memory socket census (a DO-only verb — physical facts, never event-derivable). */
async function rpcStubPagersOf(ctx: string): Promise<number> {
  return ((await stub(ctx).rpcStubTransportState()) as { rpcStubPagers: number }).rpcStubPagers;
}

/** Attach the native DO rejection inside its actor turn. `expect(promise).rejects` observes it only
 * after the test callback returns, which workerd reports as an unhandled native RPC rejection. */
async function rejected(operation: Promise<unknown>): Promise<unknown> {
  return await operation.then(
    () => {
      throw new Error("expected native Durable Object operation to reject");
    },
    (error: unknown) => error,
  );
}

/** The code of a call that MUST reject — awaited over the capnweb session, not the raw DO stub: a
 *  rejecting DO call through the vitest-plugin's RPC bridge is echoed by workerd as an "Uncaught (in
 *  promise)" line even when caught; over /api the CODED error simply crosses the hop. */
async function deniedCode(itx: any, call: string): Promise<string | undefined> {
  try {
    await itx.invoke(call);
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
}

/** The client rpc stub under test — a method receiver, so the registry reach is the documented
 *  pipelinable spelling `itx.rpcStubs.get('<rpcStubKey>').ping()`. */
class Alive extends RpcTarget {
  ping(): string {
    return "alive";
  }
}
