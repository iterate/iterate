// __workers-tests__/wake-causes.test.ts — WHY A CONTEXT WOKE, and the wake rule a fan-out row lives
// by (src/stream/subscription-delivery.ts, THE WAKE RULE): each entry point stamps its `itx/woken`
// with its cause — a call, and the census's kind of caller, or the alarm, and what it came back for
// — and a fan-out row is told of every wake, AT MOST ONCE: a handler that fails on one is never
// called on it again, so handling a wake never schedules another. The rows below are the loops that
// rule makes impossible, each against a real loaded handler that records every wake it is told of
// on `/sink`. Date is faked years out where an alarm runs, so workerd never fires one on its own.
// Who may call `deliverEvent` at all (the delivery loop alone) closes the file. The delivery loop's
// own rows: src/stream/subscription-delivery.test.ts.
import { evictDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { expect, test, vi } from "vitest";
import type { StreamEvent } from "iterate/stream/processor";
import { ITX_EXPRESSION_FETCH_HEADER } from "../src/context/rpc-stubs.ts";
import { owedAlarmOf, readLog, refused, stub, until } from "./support.ts";

/** A person signed in at the edge: what a session's call carries. */
const PERSON = { actor: "usr_wake_causes", email: "person@example.test" };

test.for([
  {
    name: "a signed-in session's call",
    call: (ctx: string) => stub(ctx).invoke("itx.whoami()", [], { principal: PERSON }),
    wake: { cause: "call", caller: "other" },
  },
  {
    name: "another context's hop",
    call: (ctx: string) =>
      stub(ctx).invoke("itx.whoami()", [], { principal: PERSON, path: "/elsewhere" }),
    wake: { cause: "call", caller: "context" },
  },
  {
    name: "loaded code's call",
    call: (ctx: string) => stub(ctx).invoke("itx.whoami()", [], { principal: null, app: true }),
    wake: { cause: "call", caller: "loaded" },
  },
  {
    name: "an expression fetch",
    call: (ctx: string) =>
      stub(ctx).fetch(
        new Request("https://project.test/", {
          headers: { [ITX_EXPRESSION_FETCH_HEADER]: JSON.stringify(["itx", "nosuch"]) },
        }),
      ),
    wake: { cause: "call", caller: "other" },
  },
  {
    name: "another context's append (an ancestor announcement)",
    call: (ctx: string) => stub(ctx).append({ type: "test/announced" }),
    wake: { cause: "call", caller: "other" },
  },
])("each entry point stamps its wake: $name", async ({ call, wake }) => {
  const ctx = `prj_wake_entry_${crypto.randomUUID().slice(0, 8)}`;
  await stub(ctx).invoke("itx.whoami()"); // born, and its birth's wake recorded
  await evictDurableObject(stub(ctx));
  await call(ctx);
  expect((await wokens(ctx)).at(-1)).toMatchObject({ payload: wake });
});

test.for([
  {
    name: "an idle project, a row on every context",
    handler: "recordOnly",
    paths: ["/", "/a", "/b"],
  },
  { name: "a handler that touches its own context", handler: "touchOwnContext", paths: ["/x"] },
  { name: "a handler that fails on every wake", handler: "failEveryWake", paths: ["/x"] },
] as const)(
  "$name: each wake is delivered ONCE and leaves nothing owed — no retry, no dead letter, no wake of the handler's making, no alarm armed, three rounds running",
  async ({ handler, paths }) => {
    const project = freshProject();
    const contexts = paths.map((path) => at(project, path));
    for (const ctx of contexts) await configureWakeHandler(ctx, HANDLER[handler]);
    const before = (await deliveredWakes(project)).length;
    for (let round = 1; round <= 3; round++) {
      for (const ctx of contexts) {
        await evictDurableObject(stub(ctx));
        await stub(ctx).invoke("itx.whoami()", [], { principal: PERSON });
      }
      await until(`round ${round}'s wakes delivered`, async () =>
        (await deliveredWakes(project)).length === before + round * contexts.length
          ? true
          : undefined,
      );
      for (const ctx of contexts) {
        await settled(ctx);
        expect(await owedAlarmOf(stub(ctx))).toBeNull();
      }
    }
    // one wake a round per context, each a distinct incarnation: none told twice
    const delivered = (await deliveredWakes(project)).slice(before);
    expect(
      new Set(delivered.map(({ path, incarnation }) => `${path}#${incarnation}`)),
    ).toHaveProperty("size", 3 * contexts.length);
    for (const ctx of contexts) {
      expect(await wokens(ctx)).toHaveLength(4); // the birth and three rounds
      expect(
        (await readLog(ctx)).filter(
          (event) => event.type === "events.iterate.com/itx/subscription-delivery-failed",
        ),
      ).toEqual([]);
    }
  },
);

test("a read of a context's rules on another context's behalf records no wake: the incarnation it woke is recorded by its own next call, of that call's kind", async () => {
  const ctx = `prj_wake_snapshot_${crypto.randomUUID().slice(0, 8)}`;
  await stub(ctx).invoke("itx.whoami()");
  await evictDurableObject(stub(ctx));
  await stub(ctx).rulesSnapshot();
  await stub(ctx).invoke("itx.whoami()", [], { principal: null, app: true });
  expect((await wokens(ctx)).map((event) => event.payload)).toEqual([
    { incarnation: 1, cause: "call" },
    { incarnation: 2, cause: "call", caller: "loaded" },
  ]);
});

test("a cross-context ping on wake — X's wake appends to Y, Y's wake appends to X — ends: Y's wake is delivered once, X was awake for Y's ping, and both are left owing nothing", async () => {
  const project = freshProject();
  const [x, y] = [at(project, "/x"), at(project, "/y")];
  for (const ctx of [x, y]) await configureWakeHandler(ctx, HANDLER.pingTheOther);
  const before = (await deliveredWakes(project)).length;
  for (const ctx of [x, y]) await evictDurableObject(stub(ctx));
  await stub(x).invoke("itx.whoami()", [], { principal: PERSON });
  await until("both wakes delivered", async () =>
    (await deliveredWakes(project)).length === before + 2 ? true : undefined,
  );
  await settled(x);
  await settled(y);
  expect((await deliveredWakes(project)).slice(before)).toMatchObject([
    { path: "/x", cause: "call", caller: "other" },
    { path: "/y", cause: "call", caller: "loaded" },
  ]);
  for (const ctx of [x, y]) {
    expect((await readLog(ctx)).filter((event) => event.type === "test/ping")).toHaveLength(1);
    expect(await owedAlarmOf(stub(ctx))).toBeNull();
  }
});

test('a schedule that fires on an idle context is a wake delivered once, with cause `alarm` and `due: ["schedule"]`', async () => {
  const start = Date.parse("2035-01-01T00:00:00Z");
  vi.useFakeTimers({ now: start, toFake: ["Date"] });
  try {
    const project = freshProject();
    const x = at(project, "/x");
    await configureWakeHandler(x, HANDLER.recordOnly);
    await stub(x).invoke(
      [
        "itx",
        "schedules",
        [
          "set",
          {
            key: "tick",
            when: { at: new Date(start + 60_000).toISOString() },
            events: [{ type: "test/tick" }],
          },
        ],
      ],
      [],
      { principal: PERSON },
    );
    await settled(x);
    const before = (await deliveredWakes(project)).length;
    await evictDurableObject(stub(x));
    vi.setSystemTime(start + 60_001);
    expect(await runDurableObjectAlarm(stub(x))).toBe(true);
    await until("the schedule's wake delivered", async () =>
      (await deliveredWakes(project)).length > before ? true : undefined,
    );
    await settled(x);
    expect((await deliveredWakes(project)).slice(before)).toMatchObject([
      { path: "/x", cause: "alarm", due: ["schedule"] },
    ]);
    expect(await owedAlarmOf(stub(x))).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

// ── `deliverEvent` is the delivery loop's call alone ──

test("deliverEvent and processEvent answer the delivery loop alone: loaded code, a session and a principal-less caller are refused FORBIDDEN — a loaded worker's and the platform hook's alike", async () => {
  const project = freshProject();
  const worker = ["workers", ["get", { source: handlerSource(HANDLER.recordOnly) }]];
  const forged = { type: "events.iterate.com/itx/woken", offset: 1, path: "/x", payload: {} };
  const attempts = [
    {
      caller: { principal: null, app: true as const },
      call: ["itx", ...worker, ["deliverEvent", forged]],
    },
    { caller: { principal: PERSON }, call: ["itx", ...worker, ["deliverEvent", forged]] },
    {
      caller: { principal: null, app: true as const },
      call: ["itx", ...worker, ["processEvent", forged]],
    },
    { caller: { principal: PERSON }, call: ["itx", ...worker, ["processEvent", forged]] },
    {
      caller: { principal: PERSON },
      call: ["itx", "builtins", "platformHook", ["deliverEvent", forged]],
    },
    {
      caller: { principal: null },
      call: ["itx", "builtins", "platformHook", ["deliverEvent", forged]],
    },
  ];
  for (const { caller, call } of attempts)
    await refused(() => stub(project).invoke(call as never, [], caller), "FORBIDDEN");
  expect(await deliveredWakes(project)).toEqual([]);
});

test("a fan-out row on the platform hook takes every durable event of its context, one call each, and settles", async () => {
  const ctx = at(freshProject(), "/x");
  await stub(ctx).append({
    type: "events.iterate.com/itx/subscription-configured",
    payload: {
      name: "platform",
      target: "itx.builtins.platformHook.deliverEvent",
      afterOffset: 0,
      ordered: false,
    },
  });
  for (let n = 0; n < 5; n++) await stub(ctx).append({ type: "test/fact", payload: { n } });
  const head = (await readLog(ctx)).at(-1)!.offset;
  await until("the platform hook settled every event", async () => {
    const row = await subscriptionRow(ctx, "platform");
    return row?.cursor?.confirmedOffset === head && row.pending === 0 ? true : undefined;
  });
  const row = await subscriptionRow(ctx, "platform");
  expect(row).toMatchObject({ ordered: false, pending: 0, paused: false });
  expect(row).not.toHaveProperty("halted");
});

/** The handlers, each a loaded worker's `deliverEvent`: every wake it is told of recorded on
 *  `/sink` first (`deliveredWakes`), then what the row tests. */
const HANDLER = {
  recordOnly: "",
  touchOwnContext: "await itx.readEvents(0, 1);",
  failEveryWake: 'throw new Error("this handler refuses every wake");',
  pingTheOther: 'await itx.cd(event.path === "/x" ? "/y" : "/x").append({ type: "test/ping" });',
};

function handlerSource(onWake: string) {
  return {
    "package.json": '{"main":"worker.js"}',
    "worker.js": /* js */ `
import { WorkerEntrypoint } from "cloudflare:workers";
import { withItx } from "iterate/with-itx";
export default class WakeHandler extends WorkerEntrypoint {
  deliverEvent(event) {
    if (event.type !== "events.iterate.com/itx/woken") return;
    return withItx(this.env.ITX, async (itx) => {
      await itx.cd("/sink").append({
        type: "test/wake-delivered",
        payload: { path: event.path, ...event.payload },
      });
      ${onWake}
    });
  }
}
`,
  };
}

/** `ctx`'s fan-out row `config`: every durable event, one at a time, to a loaded handler that
 *  records each wake it is told of on the project's `/sink` and then runs `onWake`. */
async function configureWakeHandler(ctx: string, onWake: string) {
  await stub(ctx).append({
    type: "events.iterate.com/itx/subscription-configured",
    payload: {
      name: "config",
      target: ["itx", "workers", ["get", { source: handlerSource(onWake) }], "deliverEvent"],
      consumes: ["*"],
      ordered: false,
    },
  });
  await settled(ctx);
}

/** Every wake a handler of `project` was told of, in order (the handler's own record of it). */
async function deliveredWakes(project: string) {
  return (await readLog(at(project, "/sink")))
    .filter((event) => event.type === "test/wake-delivered")
    .map(
      (event) =>
        event.payload as { path: string; incarnation: number; cause: string; caller?: string },
    );
}

/** `ctx`'s wake records. */
async function wokens(ctx: string): Promise<StreamEvent[]> {
  return (await readLog(ctx)).filter((event) => event.type === "events.iterate.com/itx/woken");
}

/** `ctx`'s subscription row `name`, as `itx.subscriptions` shows it. */
async function subscriptionRow(ctx: string, name: string) {
  return (await stub(ctx).invoke(["itx", "subscriptions", ["get", name]])) as {
    ordered?: false;
    pending?: number;
    halted?: unknown;
    cursor?: { confirmedOffset: number; nextAttemptAtMs?: number };
  } | null;
}

/** Wait until `ctx`'s fan-out row `config` has settled everything it read: its claim spent and no
 *  event pending a retry. */
async function settled(ctx: string) {
  await until(`${ctx}'s fan-out row settled`, async () => {
    const row = await subscriptionRow(ctx, "config");
    return row && row.cursor?.nextAttemptAtMs === undefined && (row.pending ?? 0) === 0
      ? true
      : undefined;
  });
}

function freshProject() {
  return `prj_wake_${crypto.randomUUID().slice(0, 8)}`;
}

function at(project: string, path: string) {
  return path === "/" ? project : `${project}.iterate${path}`;
}
