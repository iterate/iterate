// Why a context woke, and the wake rule on a real handler; unit rows: src/stream/subscription-delivery.test.ts
import { evictDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import { ITX_EXPRESSION_FETCH_HEADER } from "../../../core/os/src/context/rpc-stubs.ts";
import { deliverEventWorker } from "./sources.ts";
import { at, freshProject, owedAlarmOf, PERSON, readLog, rowOf, stub, until } from "./support.ts";

test.for([
  {
    name: "a signed-in session's call",
    call: (ctx: string) => stub(ctx).invoke("itx.whoami()", [], { principal: PERSON }),
    wake: { cause: "call", caller: "other", call: "itx.whoami" },
  },
  {
    name: "another context's hop",
    call: (ctx: string) =>
      stub(ctx).invoke("itx.whoami()", [], { principal: PERSON, path: "/elsewhere" }),
    wake: { cause: "call", caller: "context", call: "itx.whoami" },
  },
  {
    name: "loaded code's call, after a read of the context's rules that records no wake",
    call: async (ctx: string) => {
      await stub(ctx).rulesSnapshot();
      await stub(ctx).invoke("itx.whoami()", [], { principal: null, app: true });
    },
    wake: { cause: "call", caller: "loaded", call: "itx.whoami" },
  },
  {
    name: "an expression fetch",
    call: (ctx: string) =>
      stub(ctx).fetch(
        new Request("https://project.test/", {
          headers: { [ITX_EXPRESSION_FETCH_HEADER]: JSON.stringify(["itx", "nosuch"]) },
        }),
      ),
    wake: { cause: "call", caller: "other", call: "fetch" },
  },
  {
    name: "another context's append",
    call: (ctx: string) => stub(ctx).append({ type: "test/announced" }),
    wake: { cause: "call", caller: "other", call: "append" },
  },
])("each entry point records one wake, stamped with its cause: $name", async ({ call, wake }) => {
  const ctx = freshProject();
  await stub(ctx).invoke("itx.whoami()"); // born, and its birth's wake recorded
  await evictDurableObject(stub(ctx));
  await call(ctx);
  const wokens = (await readLog(ctx)).filter(({ type }) => type === "events.iterate.com/itx/woken");
  expect(wokens.map(({ payload }) => payload)).toMatchObject([
    { incarnation: 1, cause: "call", caller: "other", call: "itx.whoami" }, // its birth's
    { incarnation: 2, ...wake },
  ]);
});

test("wake handlers that ping each other's context and then fail are told of each wake once and leave both owing nothing", async () => {
  const project = freshProject();
  const [x, y] = [at(project, "/x"), at(project, "/y")];
  for (const ctx of [x, y]) await configureWakeHandler(ctx);
  const before = (await told(project)).length;
  for (const ctx of [x, y]) await evictDurableObject(stub(ctx));
  await stub(x).invoke("itx.whoami()", [], { principal: PERSON });
  await until("both wakes told", async () => (await told(project)).length === before + 2);
  for (const ctx of [x, y]) await settled(ctx);
  // x was awake for y's ping, so y's wake is the last
  expect((await told(project)).slice(before)).toMatchObject([
    { path: "/x", cause: "call", caller: "other" },
    { path: "/y", cause: "call", caller: "loaded" },
  ]);
  for (const ctx of [x, y]) {
    const types = (await readLog(ctx)).map(({ type }) => type);
    expect(types.filter((type) => type === "test/ping")).toHaveLength(1);
    expect(types).not.toContain("events.iterate.com/itx/subscription-delivery-failed");
    expect(await owedAlarmOf(stub(ctx))).toBeNull();
  }
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
  const row = await until("the platform hook settled every event", async () => {
    const row = await rowOf(ctx, "platform");
    return row?.cursor?.confirmedOffset === head && row.pending === 0 && row;
  });
  expect(row).toMatchObject({ ordered: false, pending: 0, paused: false });
  expect(row).not.toHaveProperty("halted");
});

/** Records each wake it is told of on `/sink`, pings the other context, then fails. */
const WAKE_HANDLER = deliverEventWorker(/* js */ `
      if (event.type !== "events.iterate.com/itx/woken") return;
      await itx.cd("/sink").append({ type: "test/told", payload: { path: event.path, ...event.payload } });
      await itx.cd(event.path === "/x" ? "/y" : "/x").append({ type: "test/ping" });
      throw new Error("this handler fails every wake");
`);

/** `ctx`'s fan-out row `config`: every durable event, one at a time, to WAKE_HANDLER. */
async function configureWakeHandler(ctx: string) {
  await stub(ctx).append({
    type: "events.iterate.com/itx/subscription-configured",
    payload: {
      name: "config",
      target: ["itx", "workers", ["get", { source: WAKE_HANDLER }], "deliverEvent"],
      consumes: ["*"],
      ordered: false,
    },
  });
  await settled(ctx);
}

/** Every wake a handler of `project` was told of, in order. */
async function told(project: string) {
  return (await readLog(at(project, "/sink")))
    .filter(({ type }) => type === "test/told")
    .map(({ payload }) => payload as { path: string; cause: string; caller?: string });
}

/** Until `ctx`'s row `config` has settled everything it read: no claim, nothing pending. */
const settled = (ctx: string) =>
  until(`${ctx}'s row settled`, async () => {
    const row = await rowOf(ctx, "config");
    return Boolean(row) && row?.cursor?.nextAttemptAtMs === undefined && !row?.pending;
  });
