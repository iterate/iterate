// __workers-tests__/loop-guard.test.ts — THE LOOP GUARD on the worker (src/cause.ts): every event
// carries the cause of the chain of reactions it belongs to, stamped by the platform and carried
// through loaded code by the SDK's doors — no user code names one. First the accounting, one row
// per line (`cause-table`); then the normal flows it must leave alone; then the loops it stops, each
// at the depth limit with one `itx/loop-limit` fact. The delivery loop's own rows, the wake loop
// among them: src/stream/subscription-delivery.test.ts.
import { evictDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { expect, test, vi } from "vitest";
import type { StreamEvent } from "iterate/stream/processor";
import { newWebSocketRpcSession } from "capnweb";
import { runningCause, type Cause } from "../src/cause.ts";
import { receiveEmail } from "../src/integrations/email.ts";
import type { Env } from "../src/env.ts";
import {
  adminCredentials,
  ORIGIN,
  projectWithMember,
  readLog,
  refused,
  runOn,
  stub,
  until,
} from "./support.ts";

/** A person signed in at the edge: what a session's call carries. */
const PERSON = { actor: "usr_loop_guard", email: "person@example.test" };
const LOOP_LIMIT_FACT = "events.iterate.com/itx/loop-limit";

// ── the accounting ──

test("cause-table: a person's call begins a chain of its own, at depth 0 — each call its own", async () => {
  const ctx = freshProject();
  const [first] = await said(ctx);
  const [second] = await said(ctx);
  expect(causeOf(first!)).toEqual({ chain: expect.stringContaining(" with a call ~"), depth: 0 });
  expect(causeOf(second!)).not.toMatchObject({ chain: causeOf(first!).chain });
});

test("cause-table: a chain names no one — no context's path, no mail address — only the kind of thing that began it, and a loop at a context whose path is long stops at the limit all the same", async () => {
  const project = freshProject();
  const named = at(project, "/agents/ann-smith");
  const [spoken] = await said(named);
  expect(causeOf(spoken!).chain).toMatch(/ with a call ~/);
  const mailbox = await mailboxAt("loopnamed");
  await mailbox.receive({ from: "ann.smith@example.com" });
  const [received] = ofType(await readLog(mailbox.inbox), "events.iterate.com/email/received");
  expect(causeOf(received!).chain).toMatch(/ with inbound mail ~/);
  // a handler that appends what it is handed, at a 500-character path
  const deep = at(project, `/${"p".repeat(500)}`);
  await react(deep, ["test/said"], `await itx.append({ type: "test/said" });`);
  await said(deep);
  await eventually(deep, LOOP_LIMIT_FACT, 20_000);
  expect(ofType(await readLog(deep), "test/said")).toHaveLength(9);
});

test("cause-table: a delivery runs one hand-off deeper than its event, in its chain, and what the handler appends carries that", async () => {
  const ctx = freshProject();
  await react(ctx, ["test/said"], `await itx.append({ type: "test/heard" });`);
  const [spoken] = await said(ctx);
  const heard = await eventually(ctx, "test/heard");
  expect(causeOf(heard)).toEqual({ chain: causeOf(spoken!).chain, depth: 1 });
});

test("cause-table: a script runs one deeper than its request, and its settlement is a receipt at the request's depth", async () => {
  const ctx = freshProject();
  await runOn(ctx, "async (itx) => { await itx.append({ type: 'test/by-script' }); return 1; }", {
    principal: PERSON,
  });
  const log = await readLog(ctx);
  const [requested] = ofType(log, "events.iterate.com/itx/run-requested");
  const { chain } = causeOf(requested!);
  expect(causeOf(requested!)).toEqual({ chain, depth: 0 });
  expect(ofType(log, "test/by-script").map(causeOf)).toEqual([{ chain, depth: 1 }]);
  expect(ofType(log, "events.iterate.com/itx/run-settled").map(causeOf)).toEqual([
    { chain, depth: 0 },
  ]);
});

test("cause-table: a schedule's firing — and its receipt — keep the depth it was set at, and the alarm's wake is caused by the deepest work the context owes", async () => {
  const start = Date.parse("2035-01-01T00:00:00Z");
  vi.useFakeTimers({ now: start, toFake: ["Date"] });
  try {
    const ctx = freshProject();
    await react(ctx, ["test/said"], SET_ONE_SHOT("test/fired", 60_000));
    const [spoken] = await said(ctx);
    await until("the schedule set", async () => (await scheduleOf(ctx, "later")) || undefined);
    await evictDurableObject(stub(ctx));
    vi.setSystemTime(start + 60_001);
    expect(await runDurableObjectAlarm(stub(ctx))).toBe(true);
    const log = await readLog(ctx);
    const setAt = { chain: causeOf(spoken!).chain, depth: 1 };
    expect(causeOf(ofType(log, "test/fired")[0]!)).toEqual(setAt);
    expect(causeOf(ofType(log, "events.iterate.com/itx/schedule-fired")[0]!)).toEqual(setAt);
    expect(ofType(log, "events.iterate.com/itx/woken").at(-1)).toMatchObject({
      payload: { cause: "alarm", due: ["schedule"] },
      source: { cause: setAt },
    });
  } finally {
    vi.useRealTimers();
  }
});

test("cause-table: an alarm's wake is caused by the deepest of what is due when it fires — never by work owed later, which deepens no one else's wake", async () => {
  const start = Date.parse("2035-01-01T00:00:00Z");
  vi.useFakeTimers({ now: start, toFake: ["Date"] });
  try {
    const ctx = freshProject();
    await readLog(ctx);
    for (const [key, depth, afterMs] of [
      ["soon", 1, 60_000],
      ["later", 7, 120_000],
    ] as const)
      await stub(ctx).invoke(
        [
          "itx",
          "schedules",
          [
            "set",
            {
              key,
              when: { at: new Date(start + afterMs).toISOString() },
              events: [{ type: `test/${key}` }],
            },
          ],
        ],
        [],
        caller(depth),
      );
    await evictDurableObject(stub(ctx));
    vi.setSystemTime(start + 60_001);
    expect(await runDurableObjectAlarm(stub(ctx))).toBe(true);
    expect(ofType(await readLog(ctx), "events.iterate.com/itx/woken").at(-1)).toMatchObject({
      payload: { cause: "alarm", due: ["schedule"] },
      source: { cause: { chain: CHAIN, depth: 1 } },
    });
  } finally {
    vi.useRealTimers();
  }
});

test("cause-table: a retry is no new work: a delivery tried again runs at the depth it first ran at, and what it wrote before it failed — through `cd` too, in any order, skipped or not — is not written again when it is tried again, each write keyed by the delivery, where it lands and what it is; what it writes anew still lands, and the same write twice in one delivery lands once", async () => {
  const ctx = freshProject();
  await react(
    ctx,
    ["test/said"],
    /* js */ `
      const tries = Number((await itx.kv.get("tries")) || 0) + 1;
      await itx.kv.put("tries", String(tries));
      if (tries === 1) await itx.append({ type: "test/a" });
      const x = () => itx.append({ type: "test/x" });
      const sunk = () => itx.cd("./sink").append({ type: "test/sunk" });
      await Promise.all(tries === 1 ? [x(), sunk()] : [sunk(), x()]);
      await itx.append({ type: "test/b" });
      await this.withItx((again) => again.append({ type: "test/b" }));
      if (tries === 1) throw new Error("the first try fails after its writes");
      await itx.append({ type: "test/done", payload: { tries } });`,
  );
  const [spoken] = await said(ctx);
  const done = await eventually(ctx, "test/done", 20_000); // the first rung is a second out
  expect(causeOf(done)).toEqual({ chain: causeOf(spoken!).chain, depth: 1 });
  const log = await readLog(ctx);
  for (const type of ["test/a", "test/x", "test/b"]) expect(ofType(log, type)).toHaveLength(1);
  expect(ofType(log, "test/x")[0]).toMatchObject({
    idempotencyKey: expect.stringMatching(/^react:\/@\d+:append:\/:[0-9a-f]{16}$/),
  });
  expect(ofType(await readLog(at(ctx, "/sink")), "test/sunk")).toHaveLength(1);
  expect(ofType(log, "test/done")).toMatchObject([{ payload: { tries: 2 } }]);
});

test("a retry is no new work: mail a delivery sent before it failed is not sent again when it is tried again — the retry is answered with the very `email/sent` the first attempt recorded", async () => {
  const mailbox = await mailboxAt("loopretry");
  const sent = spyOnMail();
  await reactAtRoot(
    mailbox.inbox,
    ["events.iterate.com/email/received"],
    /* js */ `
      const answer = await itx.email.send({ to: "ann@example.com", subject: "Re", text: "Once" });
      const tries = Number((await itx.kv.get("mail-tries")) || 0) + 1;
      await itx.kv.put("mail-tries", String(tries));
      if (tries === 1) throw new Error("the first try fails after its send");
      const { type, offset, payload } = answer;
      await itx.append({ type: "test/done", payload: { type, offset, messageId: payload.messageId } });`,
  );
  await mailbox.receive({ from: "ann@example.com" });
  const done = await eventually(mailbox.root, "test/done", 20_000); // the first rung is a second out
  expect(sent).toHaveLength(1);
  const mailed = ofType(await readLog(mailbox.inbox), "events.iterate.com/email/sent");
  expect(mailed).toHaveLength(1);
  expect(done).toMatchObject({
    payload: {
      type: "events.iterate.com/email/sent",
      offset: mailed[0]!.offset,
      messageId: (mailed[0]!.payload as { messageId: string }).messageId,
    },
  });
});

test("mail the binding refused is sent on the retry — a refused send reserves nothing — and mail that may have gone out with nothing recorded is not sent again: that delivery fails for good, saying why", async () => {
  // refused: the first send throws, the retry sends it
  const refusing = await mailboxAt("looprefused");
  const sent = spyOnMail({ refuseFirst: true });
  await reactAtRoot(refusing.inbox, ["events.iterate.com/email/received"], MAIL);
  await refusing.receive({ from: "ann@example.com" });
  await eventually(refusing.inbox, "events.iterate.com/email/sent", 20_000);
  expect(sent).toHaveLength(1);
  expect(ofType(await readLog(refusing.inbox), "events.iterate.com/email/sent")).toHaveLength(1);
  // lost: the first try's mail goes out and its record is lost (its log refuses it, paused)
  const losing = await mailboxAt("looplost");
  await reactAtRoot(
    losing.inbox,
    ["events.iterate.com/email/received"],
    /* js */ `
      const tries = Number((await itx.kv.get("lost-tries")) || 0) + 1;
      await itx.kv.put("lost-tries", String(tries));
      const inbox = itx.cd("/integrations/email");
      if (tries === 1)
        await inbox.append({ type: "events.iterate.com/itx/paused", payload: { reason: "lose it" } });
      else await inbox.append({ type: "events.iterate.com/itx/resumed" });
      ${MAIL}`,
  );
  await losing.receive({ from: "ann@example.com" });
  const deadLetter = await eventually(
    losing.inbox,
    "events.iterate.com/itx/subscription-delivery-failed",
    20_000,
  );
  expect(JSON.stringify(deadLetter.payload)).toMatch(/may have, and recorded nothing/);
  expect(sent).toHaveLength(2); // the refused first mail's retry, and the lost one: never again
  expect(ofType(await readLog(losing.inbox), "events.iterate.com/email/sent")).toEqual([]);
});

test("cause-table: a revive keeps the cause of the claim it serves — one that failed too, owed again and served by a later incarnation", async () => {
  const start = Date.parse("2035-01-01T00:00:00Z");
  vi.useFakeTimers({ now: start, toFake: ["Date"] });
  try {
    const ctx = freshProject();
    await readLog(ctx); // born in a chain of its own, so nothing else it owes is in CHAIN
    // a claim made three hand-offs deep, due an hour from now (the test runs it sooner)
    await stub(ctx).invoke(
      ["itx", "facets", ["get", "reviver", REVIVER], ["claimNow"]],
      [],
      caller(3),
    );
    expect(await runDurableObjectAlarm(stub(ctx))).toBe(true); // its revive fails: owed again
    await evictDurableObject(stub(ctx));
    // the facet's isolate last ran code in another chain
    const other = { principal: null, cause: { chain: "another chain", depth: 5 } };
    await stub(ctx).invoke(["itx", "facets", ["get", "reviver", REVIVER], ["touch"]], [], other);
    vi.setSystemTime(start + 60 * 60_000);
    expect(await runDurableObjectAlarm(stub(ctx))).toBe(true);
    expect(ofType(await readLog(ctx), "test/revived").map(causeOf)).toEqual([
      { chain: CHAIN, depth: 3 },
    ]);
  } finally {
    vi.useRealTimers();
  }
});

test("work that died with its host too often is failed: its revive is refused WORK_FAILED, the context records one `itx/work-failed` fact and owes it no revive", async () => {
  const start = Date.parse("2035-01-01T00:00:00Z");
  vi.useFakeTimers({ now: start, toFake: ["Date"] });
  try {
    const ctx = freshProject();
    await readLog(ctx);
    await stub(ctx).invoke(
      ["itx", "facets", ["get", "doomed", DOOMED], ["claimNow"]],
      [],
      caller(1),
    );
    expect(await runDurableObjectAlarm(stub(ctx))).toBe(true);
    expect(ofType(await readLog(ctx), "events.iterate.com/itx/work-failed")).toMatchObject([
      { payload: { facet: "doomed", error: expect.stringMatching(/died with its host/) } },
    ]);
    // a day on, the alarm revives it no more
    vi.setSystemTime(start + 24 * 60 * 60_000);
    await runDurableObjectAlarm(stub(ctx));
    expect(ofType(await readLog(ctx), "events.iterate.com/itx/work-failed")).toHaveLength(1);
  } finally {
    vi.useRealTimers();
  }
});

test("cause-table: a wake and a birth are caused by the call that makes them, and past the limit neither happens — an awake context still answers a read, refuses an act, and records ONE fact for the chain", async () => {
  const project = freshProject();
  const child = at(project, "/child");
  // a birth: the child's first events, and its announcement to its ancestors, are the call's
  await stub(child).invoke("itx.whoami()", [], caller(3));
  expect(causeOf((await readLog(child))[0]!)).toEqual({ chain: CHAIN, depth: 3 });
  expect(
    ofType(await readLog(project), "events.iterate.com/itx/child-created").map(causeOf),
  ).toEqual([{ chain: CHAIN, depth: 3 }]);
  // past the limit: an unborn context is not born, a sleeping one not woken
  const unborn = at(project, "/unborn");
  await refused(() => stub(unborn).invoke("itx.whoami()", [], caller(9)), "LOOP_LIMIT");
  expect(causeOf((await readLog(unborn))[0]!)).not.toMatchObject({ chain: CHAIN }); // the read above bore it
  await evictDurableObject(stub(child));
  await refused(() => stub(child).invoke("itx.whoami()", [], caller(9)), "LOOP_LIMIT");
  expect(ofType(await readLog(child), "events.iterate.com/itx/woken")).toHaveLength(2); // birth, read
  // awake: a read answers, every act is refused, and the chain's fact is recorded once
  expect(await stub(child).invoke(["itx", ["readEvents", 0, 1]], [], caller(9))).toBeTruthy();
  for (let tries = 0; tries < 3; tries++)
    await refused(
      () => stub(child).invoke(["itx", ["append", { type: "test/x" }]], [], caller(9)),
      "LOOP_LIMIT",
      /an append of test\/x to \/child refused: it is 9 steps into a chain of reactions that began a test's chain/,
    );
  expect(ofType(await readLog(child), LOOP_LIMIT_FACT)).toMatchObject([
    { payload: { chain: CHAIN, depth: 9 }, source: { cause: { chain: CHAIN, depth: 9 } } },
  ]);
});

// ── the flows it leaves alone ──

test("request-500-calls-depth-0: a request served by loaded code makes 500 calls in its own chain, all at depth 0", async () => {
  const ctx = freshProject();
  const served = await stub(ctx).fetch(
    new Request("https://project.test/", {
      headers: {
        "x-itx-expression": JSON.stringify([
          "itx",
          "workers",
          [
            "get",
            {
              source: config(
                "",
                'for (let n = 0; n < 500; n++) await itx.append({ type: "test/served", payload: { n } });',
              ),
            },
          ],
          "fetch",
        ]),
      },
    }),
  );
  expect(served).toMatchObject({ status: 200 });
  const causes = ofType(await wholeLog(ctx), "test/served").map(causeOf);
  expect(causes).toHaveLength(500);
  expect(new Set(causes.map(({ chain }) => chain))).toHaveProperty("size", 1);
  expect(
    causes.every(({ depth, chain }) => depth === 0 && chain.includes(" with a request ~")),
  ).toBe(true);
});

test("a clock set again as it stands, from shallower in a chain, is re-grounded there: set at depth 8, then at 1, it ticks at 1", async () => {
  const start = Date.parse("2035-01-01T00:00:00Z");
  vi.useFakeTimers({ now: start, toFake: ["Date"] });
  try {
    const ctx = freshProject();
    const beat = { key: "heartbeat", when: { everyMs: 60_000 }, events: [{ type: "test/beat" }] };
    for (const depth of [8, 1])
      await stub(ctx).invoke(["itx", "schedules", ["set", beat]], [], caller(depth));
    vi.setSystemTime(start + 60_001);
    await runDurableObjectAlarm(stub(ctx));
    expect(ofType(await wholeLog(ctx), "test/beat").map(causeOf)).toEqual([
      { chain: CHAIN, depth: 1 },
    ]);
  } finally {
    vi.useRealTimers();
  }
});

test("heartbeat-50-ticks-flat: a clock set once ticks at the depth it was set at, forever: fifty ticks, each handled one deeper, never climbing", async () => {
  const start = Date.parse("2035-01-01T00:00:00Z");
  vi.useFakeTimers({ now: start, toFake: ["Date"] });
  try {
    const ctx = freshProject();
    // init sets the heartbeat (as a publication's delivery would: depth 1), and a handler reacts
    // to each beat by appending
    await react(
      ctx,
      ["test/init", "test/beat"],
      /* js */ `
        if (event.type === "test/init")
          await itx.schedules.set({ key: "heartbeat", when: { everyMs: 60_000 }, events: [{ type: "test/beat" }] });
        else await itx.append({ type: "test/handled" });`,
    );
    await stub(ctx).invoke(["itx", ["append", { type: "test/init" }]], [], caller(0));
    await until("the heartbeat set", async () => (await scheduleOf(ctx, "heartbeat")) || undefined);
    for (let tick = 1; tick <= 50; tick++) {
      vi.setSystemTime(start + tick * 60_000 + 1);
      await runDurableObjectAlarm(stub(ctx));
      await until(`tick ${tick} handled`, async () =>
        ofType(await wholeLog(ctx), "test/handled").length === tick ? true : undefined,
      );
    }
    const log = await wholeLog(ctx);
    expect(new Set(ofType(log, "test/beat").map(({ source }) => source!.cause!.depth))).toEqual(
      new Set([1]),
    );
    expect(ofType(log, "test/handled").map(causeOf)).toEqual(
      Array.from({ length: 50 }, () => ({ chain: CHAIN, depth: 2 })),
    );
    expect(ofType(log, LOOP_LIMIT_FACT)).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});

test("init-at-8-installs-agent: a publication at depth 7 — a commit an agent's script made — is delivered at 8, and init still installs: it births a context and appends there", async () => {
  const project = freshProject();
  await react(
    project,
    ["events.iterate.com/project/worker-updated"],
    `await itx.cd("/agents/installed").append({ type: "test/installed" });`,
  );
  // the platform's fact, at the commit's depth (project/durable-object.ts `appendAsPlatform`)
  await stub(project).invoke(
    [
      "itx",
      "builtins",
      [
        "append",
        {
          type: "events.iterate.com/project/worker-updated",
          payload: { commitOid: "c", generation: 1, modules: {} },
        },
      ],
    ],
    [],
    { principal: null, platform: true, cause: { chain: CHAIN, depth: 7 } },
  );
  // read only once the root has heard of it: a read before would bear it itself
  await until(
    "the agent's context announced",
    async () =>
      ofType(await readLog(project), "events.iterate.com/itx/child-created").some(
        ({ payload }) => payload?.childPath === "/agents/installed",
      ) || undefined,
  );
  const log = await readLog(at(project, "/agents/installed"));
  expect(ofType(log, "events.iterate.com/itx/created").map(causeOf)).toEqual([
    { chain: CHAIN, depth: 8 },
  ]);
  expect(ofType(log, "test/installed").map(causeOf)).toEqual([{ chain: CHAIN, depth: 8 }]);
});

// ── the loops it stops ──

test("one-shot-rearm-climbs: a handler that sets its own one-shot again each time it fires climbs one hand-off a lap, and past the limit its schedule is refused: nine ticks, one fact, nothing owed", async () => {
  const start = Date.parse("2035-01-01T00:00:00Z");
  vi.useFakeTimers({ now: start, toFake: ["Date"] });
  try {
    const ctx = freshProject();
    await react(ctx, ["test/tick"], SET_ONE_SHOT("test/tick", 1_000));
    await said(ctx); // the context is born before the chain starts
    await stub(ctx).invoke(["itx", ["append", { type: "test/tick" }]], [], { principal: PERSON });
    for (let lap = 1; lap < 20; lap++) {
      const settled = await until(`lap ${lap} handled`, async () => {
        const log = await wholeLog(ctx);
        if (ofType(log, LOOP_LIMIT_FACT).length > 0) return "stopped";
        const scheduled = await scheduleOf(ctx, "later");
        return scheduled ? "rearmed" : undefined;
      });
      if (settled === "stopped") break;
      vi.setSystemTime(Date.now() + 1_001);
      await runDurableObjectAlarm(stub(ctx));
    }
    const log = await wholeLog(ctx);
    const ticks = ofType(log, "test/tick").map(causeOf);
    expect(ticks.map(({ depth }) => depth)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(new Set(ticks.map(({ chain }) => chain))).toHaveProperty("size", 1);
    expect(ofType(log, LOOP_LIMIT_FACT)).toMatchObject([
      { payload: { chain: ticks[0]!.chain, depth: 9 } },
    ]);
    expect(await scheduleOf(ctx, "later")).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

test("sleeping-read-pingpong-stops: a handler that reads a sleeping context on each wake wakes it one hand-off deeper, and past the limit the read that would wake the next one is refused", async () => {
  // the ping-pong unrolled: context n reads context n+1 (its child — loaded code reaches down), each
  // asleep when it is read
  const project = freshProject();
  const paths = Array.from({ length: 12 }, (_, n) => "/n".repeat(n + 1));
  for (const path of paths)
    await react(at(project, path), ["events.iterate.com/itx/woken"], READ_THE_NEXT);
  for (const path of paths) await evictDurableObject(stub(at(project, path)));
  const next = at(project, paths[9]!);
  const nextAsleep = await sweep(next);
  await stub(at(project, paths[0]!)).invoke("itx.whoami()", [], { principal: PERSON });
  const last = at(project, paths[8]!);
  // polled by the sweep's read, which records no wake: a read of ours would wake it first
  await until(
    "the ping-pong stopped",
    async () => ofType(await sweep(last), LOOP_LIMIT_FACT).length > 0 || undefined,
    30_000, // nine loaded handlers, each in an isolate of its own
  );
  // each context woken one deeper than the one that read it, up to the limit, and no further
  const wokeAt = [];
  for (const path of paths.slice(0, 9)) {
    const woken = ofType(await readLog(at(project, path)), "events.iterate.com/itx/woken");
    wokeAt.push(woken.at(-1)!.source!.cause!.depth);
  }
  expect(wokeAt).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  expect(ofType(await readLog(last), LOOP_LIMIT_FACT)).toMatchObject([
    { payload: { depth: 9, error: expect.stringMatching(/waking (\/n){10} refused/) } },
  ]);
  // the next one was never woken: not by the refused read, nor by a read of its table on the way
  expect(await sweep(next)).toEqual(nextAsleep);
});

test("agent-20-turns-one-depth: a processor's own loop — a turn, its script, the settlement, the next turn — stays at the depth of what set it going for all twenty turns; only the scripts run one deeper", async () => {
  const ctx = freshProject();
  await stub(ctx).append({
    type: "events.iterate.com/itx/subscription-configured",
    payload: {
      name: "agent",
      target: ["itx", "facets", ["get", "agent", AGENT_SPEC], "processEventBatch"],
      consumes: ["test/said", "events.iterate.com/itx/run-settled"],
    },
  });
  const [spoken] = await said(ctx);
  const { chain } = causeOf(spoken!);
  const log = await until(
    "twenty turns",
    async () => {
      const events = await wholeLog(ctx);
      return ofType(events, "events.iterate.com/itx/run-settled").length >= 20 ? events : undefined;
    },
    60_000,
  );
  const turn = { chain, depth: 0 };
  expect(ofType(log, "events.iterate.com/itx/run-requested").map(causeOf)).toEqual(
    Array.from({ length: 20 }, () => turn),
  );
  expect(ofType(log, "events.iterate.com/itx/run-settled").map(causeOf)).toEqual(
    Array.from({ length: 20 }, () => turn),
  );
  expect(ofType(log, "test/effect").map(causeOf)).toEqual(
    Array.from({ length: 20 }, () => ({ chain, depth: 1 })),
  );
  expect(ofType(log, LOOP_LIMIT_FACT)).toEqual([]);
});

test("email-thread-5-replies: five messages of one thread from outside each begin a chain, and each reply goes out one deeper, marked as ours", async () => {
  const mailbox = await mailboxAt("loopthread");
  const sent = spyOnMail();
  await reactAtRoot(
    mailbox.inbox,
    ["events.iterate.com/email/received"],
    `await itx.email.send({ inReplyToOffset: event.offset, text: "Thanks" });`,
  );
  for (let n = 1; n <= 5; n++)
    await mailbox.receive({
      from: "ann@example.com",
      messageId: `m${n}@example.com`,
      inReplyTo: n > 1 ? `m${n - 1}@example.com` : undefined,
    });
  await until("five replies", () => sent.length === 5 || undefined, 20_000);
  const received = ofType(await readLog(mailbox.inbox), "events.iterate.com/email/received");
  expect(received.map(({ source }) => source!.cause!.depth)).toEqual([0, 0, 0, 0, 0]);
  expect(new Set(received.map(({ source }) => source!.cause!.chain))).toHaveProperty("size", 5);
  for (const message of sent)
    expect(message.headers).toMatchObject({
      "Auto-Submitted": "auto-generated",
      "X-Iterate-Cause": expect.stringContaining('"depth":1'),
    });
});

test("default-email-send-handler: a handler that answers every message — its own answers coming back to it — sends eight, one deeper each time, and past the limit sends nothing more: one fact", async () => {
  const mailbox = await mailboxAt("loopecho");
  const sent = spyOnMail();
  await reactAtRoot(
    mailbox.inbox,
    ["events.iterate.com/email/received"],
    `await itx.email.send({ to: "echo@example.com", subject: "Re", text: "Got it" });`,
  );
  await mailbox.receive({ from: "echo@example.com" });
  // each message we send reaches us again, our mark on it — a copy to ourselves, an auto-reply
  // that keeps the headers — until the chain stops
  for (let echoed = 0; echoed < 20; echoed++) {
    const next = await until(
      "the next answer, or the end",
      async () =>
        ofType(await readLog(mailbox.root), LOOP_LIMIT_FACT).length > 0
          ? "stopped"
          : sent.length > echoed
            ? "sent"
            : undefined,
      20_000,
    );
    if (next === "stopped") break;
    await mailbox.receive({
      from: "echo@example.com",
      mark: sent[echoed]!.headers["X-Iterate-Cause"],
    });
  }
  expect(sent.map((message) => JSON.parse(message.headers["X-Iterate-Cause"]!).depth)).toEqual([
    1, 2, 3, 4, 5, 6, 7, 8,
  ]);
  expect(ofType(await readLog(mailbox.root), LOOP_LIMIT_FACT)).toMatchObject([
    { payload: { depth: 9, error: expect.stringMatching(/itx\.email\.send refused/) } },
  ]);
});

test("cross-project-webhooks-stop-at-8: two projects whose webhooks feed each other's hosts carry our mark across, one deeper each lap, and past the limit nothing more is sent", async () => {
  const [a, b] = [freshProject(), freshProject()];
  // the receiver: whatever each hook is sent, forwarded — mark and all — to the other project's
  // loaded code, which appends it there as its own ping
  relayHooks({ "/a": a, "/b": b });
  for (const [ctx, other] of [
    [a, "/b"],
    [b, "/a"],
  ] as const)
    await stub(ctx).append({
      type: "events.iterate.com/itx/subscription-configured",
      payload: {
        name: "hook",
        target: ["itx", "webhooks", ["get", { url: `${HOOKS}${other}` }], "deliverEvent"],
        consumes: ["test/ping"],
        ordered: false,
      },
    });
  await stub(a).invoke(["itx", ["append", { type: "test/ping" }]], [], { principal: PERSON });
  await until(
    "the ping-pong stopped",
    async () => ofType(await readLog(a), LOOP_LIMIT_FACT).length > 0 || undefined,
    30_000,
  );
  const pings = [...ofType(await readLog(a), "test/ping"), ...ofType(await readLog(b), "test/ping")]
    .map(causeOf)
    .sort((x, y) => x.depth - y.depth);
  expect(pings.map(({ depth }) => depth)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  expect(new Set(pings.map(({ chain }) => chain))).toHaveProperty("size", 1);
  expect(ofType(await readLog(a), LOOP_LIMIT_FACT)).toMatchObject([
    { payload: { depth: 9, error: expect.stringMatching(/egress to hooks\.test refused/) } },
  ]);
});

test("causeless-call: a worker's own method runs under the call that makes it — a person's, a chain of its own at depth 0, each call its own write — however deep a chain its isolate ran just before, and loaded code with no SDK at all begins a chain — a call is never refused for lack of one", async () => {
  const ctx = freshProject();
  // a delivery past the limit first, in the same isolate: its handler's append is refused
  await react(ctx, ["test/said"], `await itx.append({ type: "test/heard" });`);
  await stub(ctx).invoke(["itx", ["append", { type: "test/said" }]], [], caller(8));
  await eventually(ctx, LOOP_LIMIT_FACT);
  const handler = config(`await itx.append({ type: "test/heard" });`);
  for (let call = 0; call < 2; call++)
    await stub(ctx).invoke(["itx", "workers", ["get", { source: handler }], ["later"]], [], {
      principal: PERSON,
    });
  const person = { chain: expect.stringContaining(" with a call ~"), depth: 0 };
  expect(ofType(await readLog(ctx), "test/later").map(causeOf)).toEqual([person, person]);
  // loaded code with no SDK at all: its calls name no cause, and begin a chain of their own
  await stub(ctx).invoke(
    ["itx", "workers", ["get", { source: RAW_WORKER }], ["act"]],
    [],
    caller(1),
  );
  expect(ofType(await readLog(ctx), "test/raw").map(causeOf)).toEqual([
    { chain: expect.stringContaining(" with loaded code ~"), depth: 0 },
  ]);
});

test("a session opened with our mark — our own code calling the platform back over /api — resumes the chain it carries: at the limit its append lands there, and past it one is refused", async () => {
  const project = freshProject();
  for (const depth of [8, 9]) {
    const opened = await exports.default.fetch(`${ORIGIN}/api`, {
      headers: {
        Upgrade: "websocket",
        "iterate-cause": JSON.stringify({ chain: CHAIN, depth, hops: 0 }),
      },
    });
    opened.webSocket!.accept();
    const session = newWebSocketRpcSession(opened.webSocket as unknown as WebSocket) as any;
    const appended = session
      .authenticate(adminCredentials())
      .projects.get(project)
      .append({ type: "test/marked" });
    if (depth === 8) expect(causeOf((await appended)[0])).toEqual({ chain: CHAIN, depth: 8 });
    else
      expect(
        await appended.then(
          () => "answered",
          (error: unknown) => String(error),
        ),
      ).toMatch(/refused/);
    session[Symbol.dispose]();
  }
});

test("hop-16-throws: a request re-entering the platform carries its hops, and the one that would cross a seventeenth context is refused 508, naming its chain", async () => {
  const request = (hops: number) =>
    exports.default.fetch(
      new Request("https://control.test/version", {
        headers: { "iterate-cause": JSON.stringify({ chain: CHAIN, depth: 1, hops }) },
      }),
    );
  expect(await request(15)).toMatchObject({ status: 200 });
  const refusedRequest = await request(16);
  expect(refusedRequest).toMatchObject({ status: 508 });
  expect(await refusedRequest.text()).toMatch(
    /crossed more than 16 contexts in the chain that began a test's chain/,
  );
});

test.for([
  { act: "an append", code: `await itx.append({ type: "test/acted" });`, where: "/" },
  { act: "egress", code: `await fetch("https://elsewhere.test/");`, where: "/" },
  {
    act: "a commit",
    code: `await itx.repos.get("/repos/x").commitFiles({ message: "m", changes: [{ path: "a", content: "b" }] });`,
    where: "/repos/x",
  },
])(
  "refused-act-one-fact: $act past the limit — in a delivery, or in a request marked past it — is refused and recorded once, where it was refused: nothing lands or leaves, nothing is retried or reported",
  async ({ code, where }) => {
    const sent = spyOnElsewhere();
    const issues = vi.spyOn(console, "error");
    const delivered = freshProject();
    const requested = freshProject();
    for (const project of [delivered, requested]) await readLog(at(project, where)); // awake
    await react(delivered, ["test/said"], code);
    await stub(delivered).invoke(["itx", ["append", { type: "test/said" }]], [], caller(8));
    const answer = await stub(requested).fetch(
      new Request("https://project.test/", {
        headers: {
          "x-itx-expression": JSON.stringify([
            "itx",
            "workers",
            ["get", { source: config("", code) }],
            "fetch",
          ]),
          "iterate-cause": JSON.stringify({ chain: CHAIN, depth: 9, hops: 0 }),
        },
      }),
    );
    expect(answer).toMatchObject({ status: 508 });
    await answer.body?.cancel();
    for (const project of [delivered, requested]) {
      const refusedAt = at(project, where);
      await until("the fact", async () => ofType(await sweep(refusedAt), LOOP_LIMIT_FACT)[0]);
      expect(ofType(await readLog(refusedAt), LOOP_LIMIT_FACT)).toMatchObject([
        { payload: { chain: CHAIN, depth: 9 } },
      ]);
      expect(ofType(await readLog(refusedAt), "test/acted")).toEqual([]);
    }
    expect(sent).toEqual([]);
    expect(JSON.stringify(issues.mock.calls)).not.toMatch(/refused/);
    issues.mockRestore();
  },
);

test("a `fetch` loaded code took hold of on its module's first line carries the cause all the same: past the limit it is refused, and nothing leaves", async () => {
  const sent = spyOnElsewhere();
  const ctx = freshProject();
  await readLog(ctx); // awake
  const early = {
    "package.json": '{"main":"worker.js"}',
    "worker.js": /* js */ `
import { IterateConfigEntrypoint } from "iterate/sdk";
const early = fetch;
export default class extends IterateConfigEntrypoint {
  async fetch() {
    await early("https://elsewhere.test/");
    return new Response("sent");
  }
}
`,
  };
  const answer = await stub(ctx).fetch(
    new Request("https://project.test/", {
      headers: {
        "x-itx-expression": JSON.stringify(["itx", "workers", ["get", { source: early }], "fetch"]),
        "iterate-cause": JSON.stringify({ chain: CHAIN, depth: 9, hops: 0 }),
      },
    }),
  );
  expect(answer).toMatchObject({ status: 508 });
  await answer.body?.cancel();
  expect(sent).toEqual([]);
});

test.for([
  { name: "a processor's blocker", at: "processor" },
  { name: "a script", at: "script" },
])(
  "refused-mail-one-fact: $name that mails past the limit is refused, and the one fact is recorded where it was refused — nothing is mailed",
  async ({ at: by }) => {
    const mailbox = await mailboxAt(`loopmail${by}`);
    const sent = spyOnMail();
    if (by === "processor") {
      await stub(mailbox.root).append({
        type: "events.iterate.com/itx/subscription-configured",
        payload: {
          name: "mailer",
          target: ["itx", "facets", ["get", "mailer", MAILER_SPEC], "processEventBatch"],
          consumes: ["test/said"],
        },
      });
      // the event at the limit: the processor's effects run one past it
      await stub(mailbox.root).invoke(["itx", ["append", { type: "test/said" }]], [], caller(8));
    } else
      // the run's own caller hears its refusal (a plain handler: `.rejects` attaches a tick late
      // to a rejected RPC promise, which reports it unhandled — facets.test.ts)
      expect(
        await runOn(mailbox.root, `async (itx) => { ${MAIL} }`, caller(8)).then(
          () => "answered",
          (error: unknown) => String(error),
        ),
      ).toMatch(/itx\.email\.send refused/);
    await until("the fact", async () => ofType(await sweep(mailbox.root), LOOP_LIMIT_FACT)[0]);
    expect(ofType(await readLog(mailbox.root), LOOP_LIMIT_FACT)).toMatchObject([
      {
        payload: {
          chain: CHAIN,
          depth: 9,
          error: expect.stringMatching(/itx\.email\.send refused/),
        },
      },
    ]);
    expect(sent).toEqual([]);
  },
);

test("processor-mirror-stops-at-8: two processors that hand each other's pings on, a context apart, climb one hand-off a lap — a processor's write beyond its own log is code reacting to code — and stop at the limit: one fact", async () => {
  const project = freshProject();
  for (const path of ["/a", "/b"])
    await stub(at(project, path)).append({
      type: "events.iterate.com/itx/subscription-configured",
      payload: {
        name: "mirror",
        target: ["itx", "facets", ["get", "mirror", MIRROR_SPEC], "processEventBatch"],
        consumes: ["test/ping"],
      },
    });
  await stub(at(project, "/a")).invoke(
    ["itx", ["append", { type: "test/ping", payload: { to: "/b", back: "/a" } }]],
    [],
    { principal: PERSON },
  );
  const b = at(project, "/b");
  await until(
    "the mirror stopped",
    async () => ofType(await sweep(b), LOOP_LIMIT_FACT).length > 0 || undefined,
  );
  const depths = async (ctx: string) =>
    ofType(await readLog(ctx), "test/ping").map((ping) => causeOf(ping).depth);
  expect(await depths(at(project, "/a"))).toEqual([0, 2, 4, 6, 8]);
  expect(await depths(b)).toEqual([1, 3, 5, 7]);
  expect(ofType(await readLog(b), LOOP_LIMIT_FACT)).toMatchObject([{ payload: { depth: 9 } }]);
});

test("a read records nothing: a context read for its table while it sleeps — or before it is ever born — is neither woken nor born, so reading through it makes no wake a handler could answer", async () => {
  const project = freshProject();
  const asleep = at(project, "/asleep");
  await stub(asleep).invoke(["itx", ["append", { type: "test/said" }]], [], { principal: PERSON });
  await evictDurableObject(stub(asleep));
  const before = await sweep(asleep);
  // a person's kv reads there, each resolved through that context's table
  for (const path of ["/asleep", "/unborn"])
    await (
      stub(project).invoke(["itx", ["cd", path], "kv", ["get", "x"]], [], {
        principal: PERSON,
      }) as Promise<unknown>
    ).catch(() => {}); // whether the table answers is not the point
  expect(await sweep(asleep)).toEqual(before);
  expect(await sweep(at(project, "/unborn"))).toEqual([]);
});

test("the facet door walks only as far as Workers RPC would — a method an RpcTarget's class declares, an own member of plain data — never a target's own field or a method of data the facet holds live, and a collection's verbs still act under the call's cause", async () => {
  const ctx = freshProject();
  // the rest of an expression past a facet is one walk on it, through its door
  const walled = (...steps: (string | unknown[])[]) =>
    stub(ctx).invoke(["itx", "facets", ["get", "walled", WALLED], ...steps], [], caller(1));
  expect(await walled(["door"], ["open"])).toBe("opened");
  await refused(() => walled(["door"], ["secret"]), "NOT_A_METHOD");
  await refused(() => walled(["state"], "list", ["push", "x"]), "NOT_A_METHOD");
  expect(await walled(["count"])).toBe(0);
  const { projectId } = await projectWithMember("loopwalls");
  await refused(
    () =>
      stub(projectId).invoke(
        [
          "itx",
          "facets",
          ["get", "project"],
          ["repos"],
          ["create", "/repos/deep", { creator: "/" }],
        ],
        [],
        caller(9),
      ),
    "LOOP_LIMIT",
  );
});

test("facet-fetch-keeps-depth: a Request a call hands a facet carries the call's cause, so the facet acts at the call's depth — and past the limit it is refused there, never done in a chain of its own", async () => {
  const ctx = freshProject();
  await readLog(ctx); // born first: a call past the limit bears nothing
  for (const depth of [3, 9]) {
    const answer = await stub(ctx).fetch(
      new Request("https://project.test/", {
        headers: {
          "x-itx-expression": JSON.stringify(["itx", "facets", ["get", "acting", ACTING], "fetch"]),
          "iterate-cause": JSON.stringify({ chain: CHAIN, depth, hops: 0 }),
        },
      }),
    );
    await answer.body?.cancel();
  }
  const log = await readLog(ctx);
  expect(ofType(log, "test/by-facet").map(causeOf)).toEqual([{ chain: CHAIN, depth: 3 }]);
  expect(ofType(log, LOOP_LIMIT_FACT)).toMatchObject([{ payload: { chain: CHAIN, depth: 9 } }]);
});

test("a row to a worker's own method delivers through the SDK's door, under the delivery's cause, so a method that appends what it is handed climbs one hand-off a lap and stops at the limit: one fact", async () => {
  const ctx = freshProject();
  await stub(ctx).append({
    type: "events.iterate.com/itx/subscription-configured",
    payload: {
      name: "pinger",
      target: ["itx", "workers", ["get", { source: PINGER }], "onPing"],
      consumes: ["test/ping"],
      ordered: false,
    },
  });
  await stub(ctx).invoke(["itx", ["append", { type: "test/ping" }]], [], { principal: PERSON });
  await eventually(ctx, LOOP_LIMIT_FACT, 20_000);
  const log = await readLog(ctx);
  expect(ofType(log, "test/ping").map((ping) => causeOf(ping).depth)).toEqual([
    0, 1, 2, 3, 4, 5, 6, 7, 8,
  ]);
  expect(ofType(log, LOOP_LIMIT_FACT)).toHaveLength(1);
});

test("the platform's own isolate, which every project shares, keeps no cause outside a door: the chain one project's call ran under reaches no code another runs", async () => {
  const { projectId } = await projectWithMember("loopshared");
  // a first-party facet's door runs here, in this isolate, in a chain of project A's
  await stub(projectId).invoke(["itx", "facets", ["get", "project"], ["repos"], ["list"]], [], {
    principal: null,
    cause: { chain: "project A's chain", depth: 5 },
  });
  expect(runningCause()).toBeUndefined();
});

test.for([
  { name: "itself", next: "/" },
  { name: "the context below", next: "./n" },
])(
  "hop-17-workers: a worker that calls a worker through `cd` — to $name — hands it the hops its call made, so seventeen nest and the seventeenth's crossing is refused",
  async ({ next }) => {
    const project = freshProject();
    const hop = { source: config("", HOP_ON(next)) };
    const answer = await stub(project).fetch(
      new Request("https://project.test/", {
        method: "POST",
        headers: { "x-itx-expression": JSON.stringify(["itx", "workers", ["get", hop], "fetch"]) },
        body: JSON.stringify(hop),
      }),
    );
    expect(await answer.text()).toMatch(/crossed more than 16 contexts/);
    // one level at each context the calls reached: all at the root, or one a level down each
    const paths =
      next === "/" ? ["/"] : Array.from({ length: 17 }, (_, n) => "/n".repeat(n) || "/");
    let levels = 0;
    for (const path of paths)
      levels += ofType(await readLog(at(project, path)), "test/level").length;
    expect(levels).toBe(17);
  },
);

// ── helpers ──

/** The chain `caller(depth)` names. */
const CHAIN = "a test's chain";
/** A caller in the middle of CHAIN, `depth` hand-offs deep. */
function caller(depth: number) {
  return { principal: null, cause: { chain: CHAIN, depth } };
}

/** A person appends `test/said` on `ctx`: its committed events. */
async function said(ctx: string) {
  return (await stub(ctx).invoke(["itx", ["append", { type: "test/said" }]], [], {
    principal: PERSON,
  })) as StreamEvent[];
}

/** `ctx`'s log as the sweep reads it: a DO-only verb that records no wake and bears nothing. */
async function sweep(ctx: string) {
  // Workers RPC types its StreamPage answer as unserializable
  return ((await stub(ctx).readForSweep(0)) as unknown as { events: StreamEvent[] }).events;
}

/** Every event on `ctx`'s log, page by page. */
async function wholeLog(ctx: string) {
  const events: StreamEvent[] = [];
  for (;;) {
    const page = (await stub(ctx).invoke([
      "itx",
      ["readEvents", events.at(-1)?.offset ?? 0, 1000],
    ])) as { events: StreamEvent[]; atHead: boolean };
    events.push(...page.events);
    if (page.atHead) return events;
  }
}

/** The cause an event was stored with. */
const causeOf = (event: StreamEvent): Cause => event.source!.cause!;

const ofType = (events: StreamEvent[], type: string) =>
  events.filter((event) => event.type === type);

/** The first `type` on `ctx`'s log, once there is one. */
const eventually = (ctx: string, type: string, timeoutMs?: number) =>
  until(`${type} on ${ctx}`, async () => ofType(await readLog(ctx), type)[0], timeoutMs);

const scheduleOf = (ctx: string, key: string) =>
  stub(ctx).invoke(["itx", "schedules", ["get", key]]) as Promise<unknown>;

/** A handler's body that reads the context below its own: a read that wakes it when it sleeps. */
const READ_THE_NEXT = `await itx.cd("./n").readEvents(0, 1);`;

/** A handler's body that sets the one-shot `later`, `afterMs` after its event, to append `type`. */
const SET_ONE_SHOT = (type: string, afterMs: number) => /* js */ `
  await itx.schedules.set({
    key: "later",
    when: { at: new Date(Date.parse(event.createdAt) + ${afterMs}).toISOString() },
    events: [{ type: "${type}" }],
  });`;

/** A loaded config entrypoint (iterate/sdk): its `processEvent` runs `onEvent` (with `event` and
 *  `itx`, the context that loaded it), its `fetch` runs `onRequest` (with `request` and `itx`), and
 *  `later()`, a method of its own no door runs, appends `test/later`. */
function config(onEvent: string, onRequest = "") {
  return {
    "package.json": '{"main":"worker.js"}',
    "worker.js": /* js */ `
import { IterateConfigEntrypoint } from "iterate/sdk";
export default class extends IterateConfigEntrypoint {
  async processEvent({ event, itx }) {
    ${onEvent}
  }
  async fetch(request) {
    await this.withItx(async (itx) => {
      ${onRequest}
    });
    return new Response("served");
  }
  async later() {
    await this.withItx((itx) => itx.append({ type: "test/later" }));
  }
}
`,
  };
}

/** A config's `onRequest` that appends `test/level` and hands the spec its Request carries to the
 *  same worker at `next`, through `cd`. */
const HOP_ON = (next: string) => /* js */ `
  const spec = await request.json();
  await itx.append({ type: "test/level" });
  const answer = await itx
    .cd(${JSON.stringify(next)})
    .workers.get(spec)
    .fetch(new Request("https://hop.test/", { method: "POST", body: JSON.stringify(spec) }));
  if (!answer.ok) throw new Error(await answer.text());`;

/** A processor that hands every `test/ping` on to the context it names, naming its own back. */
const MIRROR_SPEC = {
  source: {
    "package.json": '{"main":"worker.js"}',
    "worker.js": /* js */ `
import { StreamProcessorDurableObject } from "iterate/sdk";
import { StreamProcessor, defineProcessorContract } from "iterate/stream/processor";
import { z } from "zod";
const contract = defineProcessorContract({
  slug: "mirror",
  version: "1.0.0",
  description: "hands every ping on to the context it names",
  stateSchema: z.object({}),
  consumes: ["test/ping"],
  emits: [],
});
class Mirror extends StreamProcessor {
  contract = contract;
  constructor(withItx) {
    super();
    this.withItx = withItx;
  }
  processEvent({ event, blockProcessorWhile }) {
    if (!event) return;
    const { to, back } = event.payload;
    blockProcessorWhile(() =>
      this.withItx((itx) => itx.cd(to).append({ type: "test/ping", payload: { to: back, back: to } })),
    );
  }
}
export class MirrorDurableObject extends StreamProcessorDurableObject {
  processor = new Mirror((call) => this.withItx(call));
}`,
  },
  className: "MirrorDurableObject",
};

/** A config whose own method `onPing` appends `test/ping`. */
const PINGER = {
  "package.json": '{"main":"worker.js"}',
  "worker.js": /* js */ `
import { IterateConfigEntrypoint } from "iterate/sdk";
export default class extends IterateConfigEntrypoint {
  async onPing() {
    await this.withItx((itx) => itx.append({ type: "test/ping" }));
  }
}
`,
};

/** A loaded facet that claims a revive due in an hour (`claimNow`) and whose work, revived, has died
 *  with its host too often: its revive is refused WORK_FAILED, as the SDK's engine refuses it. */
const DOOMED = {
  source: {
    "package.json": '{"main":"worker.js"}',
    "worker.js": /* js */ `
import { FacetDurableObject } from "iterate/sdk";
import { withItx } from "iterate/with-itx";
export class Doomed extends FacetDurableObject {
  static publicMethods = [...super.publicMethods, "claimNow"];
  claimNow() {
    return withItx(this.env.ITX, (itx) => itx.processors.claim("doomed", Date.now() + 3_600_000));
  }
  revive() {
    throw Object.assign(new Error("its work in flight died with its host 5 times"), {
      code: "WORK_FAILED",
    });
  }
}
`,
  },
  className: "Doomed",
};

/** A loaded facet that hands out an RpcTarget with a field of its own (`door()`) and the list it
 *  keeps, live (`state()`), and counts that list (`count()`). */
const WALLED = {
  source: {
    "package.json": '{"main":"worker.js"}',
    "worker.js": /* js */ `
import { RpcTarget } from "cloudflare:workers";
import { FacetDurableObject } from "iterate/sdk";
class Door extends RpcTarget {
  constructor(secret) { super(); this.secret = secret; }
  open() { return "opened"; }
}
export class Walled extends FacetDurableObject {
  static publicMethods = [...super.publicMethods, "door", "state", "count"];
  #list = [];
  door() { return new Door(() => "the facet's own"); }
  state() { return { list: this.#list }; }
  count() { return this.#list.length; }
}
`,
  },
  className: "Walled",
};

/** A loaded facet whose `fetch` appends `test/by-facet`. */
const ACTING = {
  source: {
    "package.json": '{"main":"worker.js"}',
    "worker.js": /* js */ `
import { FacetDurableObject } from "iterate/sdk";
import { withItx } from "iterate/with-itx";
export class Acting extends FacetDurableObject {
  async fetch() {
    await withItx(this.env.ITX, (itx) => itx.append({ type: "test/by-facet" }));
    return new Response("acted");
  }
}
`,
  },
  className: "Acting",
};

/** A loaded facet that claims a revive due in an hour (`claimNow`), whose first revive fails and
 *  whose next appends `test/revived`; `touch` does nothing. */
const REVIVER = {
  source: {
    "package.json": '{"main":"worker.js"}',
    "worker.js": /* js */ `
import { FacetDurableObject } from "iterate/sdk";
import { withItx } from "iterate/with-itx";
export class Reviver extends FacetDurableObject {
  static publicMethods = [...super.publicMethods, "claimNow", "touch"];
  touch() {}
  claimNow() {
    return withItx(this.env.ITX, (itx) => itx.processors.claim("reviver", Date.now() + 3_600_000));
  }
  async revive() {
    const tries = (this.ctx.storage.kv.get("tries") ?? 0) + 1;
    this.ctx.storage.kv.put("tries", tries);
    if (tries === 1) throw new Error("the first revive fails");
    await withItx(this.env.ITX, (itx) => itx.append({ type: "test/revived" }));
  }
}
`,
  },
  className: "Reviver",
};

/** Loaded code outside every SDK host: `act()` appends `test/raw` from an isolate no door ran. */
const RAW_WORKER = {
  "package.json": '{"main":"worker.js"}',
  "worker.js": /* js */ `
import { WorkerEntrypoint } from "cloudflare:workers";
import { withItx } from "iterate/with-itx";
export default class extends WorkerEntrypoint {
  async act() {
    await withItx(this.env.ITX, (itx) => itx.append({ type: "test/raw" }));
  }
}
`,
};

/** `ctx`'s fan-out row `react`: each event of `consumes`, one call each, to `config(onEvent)`
 *  loaded where `at` says — `ctx` itself, or (`["cd", "/"]`) the project's root, as the birth rows
 *  load the project's config. */
async function react(ctx: string, consumes: string[], onEvent: string, at: unknown[] = []) {
  await stub(ctx).append({
    type: "events.iterate.com/itx/subscription-configured",
    payload: {
      name: "react",
      target: ["itx", ...at, "workers", ["get", { source: config(onEvent) }], "deliverEvent"],
      consumes,
      ordered: false,
    },
  });
}

/** `react`, its handler loaded at the project's root, where `itx.email` is. */
const reactAtRoot = (ctx: string, consumes: string[], onEvent: string) =>
  react(ctx, consumes, onEvent, [["cd", "/"]]);

/** A project with an address, `<slug>@projects.test`: its root, its `/integrations/email`, and inbound mail
 *  to it — from outside, or carrying our mark as mail we sent that comes back does. */
async function mailboxAt(slug: string) {
  const { projectId } = await projectWithMember(slug);
  let n = 0;
  return {
    root: projectId,
    inbox: at(projectId, "/integrations/email"),
    receive: async (mail: {
      from: string;
      messageId?: string;
      inReplyTo?: string;
      mark?: string;
    }) => {
      const mime = [
        `From: ${mail.from}`,
        `To: ${slug}@projects.test`,
        "Subject: Hello",
        `Message-ID: <${mail.messageId || `${slug}-${++n}@example.com`}>`,
        ...(mail.inReplyTo ? [`In-Reply-To: <${mail.inReplyTo}>`] : []),
        ...(mail.mark ? [`X-Iterate-Cause: ${mail.mark}`, "Auto-Submitted: auto-generated"] : []),
        "",
        "Hello there.",
      ].join("\r\n");
      const raw = new TextEncoder().encode(mime);
      await receiveEmail(
        {
          from: mail.from,
          to: `${slug}@projects.test`,
          raw: new Response(raw).body!,
          rawSize: raw.byteLength,
          headers: new Headers(),
          setReject: () => {},
          forward: async () => {},
        } as unknown as ForwardableEmailMessage,
        env as unknown as Env,
      );
    },
  };
}

/** Every message the project's mail binding is asked to send, its headers as sent: taken there,
 *  never sent on (the binding's I/O is the test's, the call the context's); with `refuseFirst`, the
 *  first is refused, as the binding refuses one, and not sent. */
function spyOnMail({ refuseFirst = false } = {}) {
  const sent: { headers: Record<string, string> }[] = [];
  let refuse = refuseFirst;
  vi.spyOn(env.EMAIL!, "send").mockImplementation(async (message) => {
    if (refuse) {
      refuse = false;
      throw new Error("the binding refused it");
    }
    sent.push({ headers: (message as { headers?: Record<string, string> }).headers || {} });
    return { messageId: `<${crypto.randomUUID()}@projects.test>` } as never;
  });
  return sent;
}

/** A host outside the platform, and every request loaded code sends it: taken, never sent on. */
const ELSEWHERE = "https://elsewhere.test";
function spyOnElsewhere() {
  const sent: string[] = [];
  const through = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).origin !== ELSEWHERE) return through(request);
    sent.push(request.url);
    return new Response(null, { status: 200 });
  });
  return sent;
}

/** A script's or a handler's one mail. */
const MAIL = `await itx.email.send({ to: "ann@example.com", subject: "Hi", text: "Hi" });`;

/** A processor that mails on each `test/said`, in a blocker. */
const MAILER_SPEC = {
  source: {
    "package.json": '{"main":"worker.js"}',
    "worker.js": /* js */ `
import { StreamProcessorDurableObject } from "iterate/sdk";
import { StreamProcessor, defineProcessorContract } from "iterate/stream/processor";
import { z } from "zod";
const contract = defineProcessorContract({
  slug: "mailer",
  version: "1.0.0",
  description: "mails on each said",
  stateSchema: z.object({}),
  consumes: ["test/said"],
  emits: [],
});
class Mailer extends StreamProcessor {
  contract = contract;
  constructor(withItx) {
    super();
    this.withItx = withItx;
  }
  processEvent({ event, blockProcessorWhile }) {
    if (event) blockProcessorWhile(() => this.withItx(async (itx) => { ${MAIL} }));
  }
}
export class MailerDurableObject extends StreamProcessorDurableObject {
  processor = new Mailer((call) => this.withItx(call));
}`,
  },
  className: "MailerDurableObject",
};

/** Where the projects' webhooks POST. */
const HOOKS = "https://hooks.test";
/** A project's loaded code that takes a hook's POST and appends a ping of its own. */
const RELAY = config("", `await itx.append({ type: "test/ping" });`);

/** A receiver at HOOKS that forwards what each path is sent — our mark with it — to the project
 *  `routes` names for it, whose loaded code appends it; it answers 200 whatever that does. */
function relayHooks(routes: Record<string, string>) {
  const through = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== HOOKS) return through(request);
    const mark = request.headers.get("iterate-cause");
    await stub(routes[url.pathname]!)
      .fetch(
        new Request("https://project.test/", {
          method: "POST",
          headers: {
            "x-itx-expression": JSON.stringify([
              "itx",
              "workers",
              ["get", { source: RELAY }],
              "fetch",
            ]),
            "iterate-cause": mark || "",
          },
          body: await request.text(),
        }),
      )
      .then((answer) => answer.body?.cancel());
    return new Response(null, { status: 200 });
  });
}

/** A processor that asks its context for a run on `test/said`, and again on each settlement,
 *  twenty turns in all, each script appending `test/effect`: an agent's loop, its model left out. */
const AGENT_SPEC = {
  source: {
    "package.json": '{"main":"worker.js"}',
    "worker.js": /* js */ `
import { StreamProcessorDurableObject } from "iterate/sdk";
import { StreamProcessor, defineProcessorContract } from "iterate/stream/processor";
import { z } from "zod";
const contract = defineProcessorContract({
  slug: "agent",
  version: "1.0.0",
  description: "a turn on test/said, and another each time its script settles",
  stateSchema: z.object({ turns: z.number().default(0) }),
  consumes: ["test/said", "events.iterate.com/itx/run-settled"],
  emits: ["events.iterate.com/itx/run-requested"],
});
class AgentProcessor extends StreamProcessor {
  contract = contract;
  reduce({ event, state }) {
    if (event.type === "events.iterate.com/itx/run-settled") return { turns: state.turns + 1 };
  }
  processEvent({ event, state, append, blockProcessorWhile }) {
    if (!event || state.turns >= 20) return;
    blockProcessorWhile(() =>
      append({
        type: "events.iterate.com/itx/run-requested",
        idempotencyKey: this.idempotencyKey("turn", event),
        payload: { code: "async (itx) => { await itx.append({ type: 'test/effect' }); }" },
      }),
    );
  }
}
export class AgentDurableObject extends StreamProcessorDurableObject {
  processor = new AgentProcessor();
}`,
  },
  className: "AgentDurableObject",
};

function freshProject() {
  return `prj_loop_${crypto.randomUUID().slice(0, 8)}`;
}

function at(project: string, path: string) {
  return path === "/" ? project : `${project}.iterate${path}`;
}
