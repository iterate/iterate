// __workers-tests__/loop-guard.test.ts — the loop guard (src/cause.ts) on the worker. Its Node rows,
// the 200-world property among them: src/stream/subscription-delivery.test.ts.
import { evictDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { expect, test, vi } from "vitest";
import { ITERATE_CAUSE_HEADER } from "iterate/lib";
import type { StreamEvent } from "iterate/stream/processor";
import { newWebSocketRpcSession } from "capnweb";
import { runningCause, type Cause } from "../src/cause.ts";
import {
  adminCredentials,
  at,
  deliverMail,
  fakeDate,
  freshProject,
  interceptOrigins,
  openSession,
  ORIGIN,
  PERSON,
  projectWithMember,
  readLog,
  refused,
  rule,
  runOn,
  stub,
  until,
} from "./support.ts";

const LOOP_LIMIT_FACT = "events.iterate.com/itx/loop-limit";
const WOKEN = "events.iterate.com/itx/woken";
const RECEIVED = "events.iterate.com/email/received";
const RUN_SETTLED = "events.iterate.com/itx/run-settled";
/** The chain `caller(depth)` and `mark(depth)` name. */
const CHAIN = "a test's chain";
/** A host outside the platform. */
const ELSEWHERE = "https://elsewhere.test";
/** The project whose edge fetch route `out` forwards to `itx.fetch`. */
const ROUTED = "loop-guard-route";
/** A handler's read of the context below its own: a read that wakes it when it sleeps. */
const READ_THE_NEXT = `await itx.cd("./n").readEvents(0, 1);`;
/** A script's or a handler's one mail. */
const MAIL = `await itx.email.send({ to: "ann@example.com", subject: "Hi", text: "Hi" });`;
/** A facet whose `fetch` appends `test/acted`. */
const ACTING = facetSpec(
  "Acting",
  [],
  `async fetch() { using itx = this.getItx(); await itx.append({ type: "test/acted" }); return new Response("acted"); }`,
);

// ── the accounting ──

test("causeless-call: a method runs under the call that makes it, a chain of its own that names no one", async () => {
  const ctx = at(freshProject("prj_loop"), "/agents/ann-smith");
  // the isolate's last delivery ran past the limit
  await react(ctx, ["test/said"], `await itx.append({ type: "test/heard" });`);
  await stub(ctx).invoke(["itx", ["append", { type: "test/said" }]], [], caller(8));
  await eventually(ctx, LOOP_LIMIT_FACT);
  for (let call = 0; call < 2; call++)
    await stub(ctx).invoke(["itx", "workers", ["get", { source: config("") }], ["later"]], [], {
      principal: PERSON,
    });
  const [first, second] = ofType(await readLog(ctx), "test/later").map(causeOf);
  expect(first).toEqual({ chain: expect.stringContaining(" with a call ~"), depth: 0 });
  expect(second).toMatchObject({ depth: 0 });
  expect(second).not.toMatchObject({ chain: first!.chain });
  expect(first!.chain).not.toMatch(/ann-smith/);
});

test("cause-table: a run an `itx.run` row sends elsewhere runs one deeper than its request, there", async () => {
  const ctx = freshProject("prj_loop");
  const asPerson = (event: unknown) =>
    stub(ctx).invoke(["itx", ["append", event]], [], { principal: PERSON }) as Promise<
      StreamEvent[]
    >;
  await asPerson(rule("itx.run", "itx.builtins.cd('/sandbox').builtins.run"));
  const [requested] = await asPerson({
    type: "events.iterate.com/itx/run-requested",
    payload: { code: "async (itx) => { await itx.append({ type: 'test/by-script' }); }" },
  });
  const byScript = await eventually(at(ctx, "/sandbox"), "test/by-script");
  expect(causeOf(byScript)).toEqual({ chain: causeOf(requested!).chain, depth: 1 });
});

test("cause-table: a schedule fires at the depth it was last set at, and an alarm wakes at the deepest due", async () => {
  const start = fakeDate();
  const ctx = freshProject("prj_loop");
  await react(ctx, ["test/beat"], `await itx.append({ type: "test/handled" });`);
  const set = (depth: number, schedule: unknown) =>
    stub(ctx).invoke(["itx", "schedules", ["set", schedule]], [], caller(depth));
  const beat = { key: "heartbeat", when: { everyMs: 60_000 }, events: [{ type: "test/beat" }] };
  await set(8, beat);
  await set(1, beat); // the same clock again, from shallower: it ticks at 1 from now on
  const later = { at: new Date(start + 150_000).toISOString() };
  await set(7, { key: "later", when: later, events: [{ type: "test/later" }] });
  await evictDurableObject(stub(ctx));
  for (let tick = 1; tick <= 10; tick++) {
    vi.setSystemTime(start + tick * 60_000 + 1);
    await runDurableObjectAlarm(stub(ctx));
    await until(
      `tick ${tick} handled`,
      async () => ofType(await readLog(ctx), "test/handled").length === tick || undefined,
    );
  }
  const log = await readLog(ctx);
  const depths = (type: string) => ofType(log, type).map((event) => causeOf(event).depth);
  // the first alarm owed only the clock: the deeper one-shot was not yet due
  expect(ofType(log, WOKEN)[1]).toMatchObject({
    payload: { cause: "alarm", due: ["schedule"] },
    source: { cause: { chain: CHAIN, depth: 1 } },
  });
  expect(depths("test/later")).toEqual([7]);
  expect(depths("test/beat")).toEqual(Array(10).fill(1));
  expect(depths("test/handled")).toEqual(Array(10).fill(2));
  expect(depths("events.iterate.com/itx/schedule-fired").sort()).toEqual([...Array(10).fill(1), 7]);
  expect(ofType(log, LOOP_LIMIT_FACT)).toEqual([]);
});

test("cause-table: a retried delivery runs at its first depth and writes nothing twice", async () => {
  const ctx = freshProject("prj_loop");
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
      {
        using again = this.getItx();
        await again.append({ type: "test/b" });
      }
      if (tries === 1) throw new Error("the first try fails after its writes");
      await itx.append({ type: "test/done", payload: { tries } });`,
  );
  const [spoken] = await said(ctx);
  const done = await eventually(ctx, "test/done", 20_000); // the first rung is a second out
  // its parent is the event it was delivered for
  expect(causeOf(done)).toEqual({
    chain: causeOf(spoken!).chain,
    depth: 1,
    parent: `${spoken!.path}@${spoken!.offset}`,
  });
  const log = await readLog(ctx);
  for (const type of ["test/a", "test/x", "test/b"]) expect(ofType(log, type)).toHaveLength(1);
  expect(ofType(await readLog(at(ctx, "/sink")), "test/sunk")).toHaveLength(1);
  expect(ofType(log, "test/done")).toMatchObject([{ payload: { tries: 2 } }]);
});

test.for([
  { name: "a retry is answered with the mail its first try sent", first: "sent" },
  { name: "mail the binding refused is sent on the retry", first: "refused" },
  { name: "mail that may have gone out unrecorded is never sent again", first: "lost" },
] as const)("at most once: $name", async ({ first }) => {
  const mailbox = await mailboxAt(`loop${first}`);
  const sent = spyOnMail({ refuseFirst: first === "refused" });
  // lost: the first try's record is refused (its log paused) after the mail went out
  const lose = /* js */ `
    const inbox = itx.cd("/integrations/email");
    if (tries === 1) await inbox.append({ type: "events.iterate.com/itx/paused", payload: { reason: "lose it" } });
    else await inbox.append({ type: "events.iterate.com/itx/resumed" });`;
  await reactAtRoot(
    mailbox.inbox,
    [RECEIVED],
    /* js */ `
      const tries = Number((await itx.kv.get("tries")) || 0) + 1;
      await itx.kv.put("tries", String(tries));
      ${first === "lost" ? lose : ""}
      const { offset } = await itx.email.send({ to: "ann@example.com", subject: "Hi", text: "Hi" });
      if (tries === 1) throw new Error("the first try fails after its send");
      await itx.append({ type: "test/done", payload: { offset } });`,
  );
  await mailbox.receive({ from: "ann@example.com" });
  const mailed = async () => ofType(await readLog(mailbox.inbox), "events.iterate.com/email/sent");
  if (first === "lost") {
    const deadLetter = await eventually(
      mailbox.inbox,
      "events.iterate.com/itx/subscription-delivery-failed",
      20_000,
    ); // the first rung is a second out
    expect(JSON.stringify(deadLetter.payload)).toMatch(/may have, and recorded nothing/);
    expect(await mailed()).toEqual([]);
  } else {
    const done = await eventually(mailbox.root, "test/done", 20_000); // the first rung is a second out
    expect(done).toMatchObject({ payload: { offset: (await mailed())[0]!.offset } });
  }
  expect(sent).toHaveLength(1);
});

test("cause-table: a revive keeps its claim's cause across a failed one; work that died too often fails once", async () => {
  const start = fakeDate();
  const ctx = freshProject("prj_loop");
  await readLog(ctx); // born in a chain of its own
  // each facet is named after the claim it makes, which its revive serves
  const facet = (name: string, spec: object, method: string, cause = caller(3)) =>
    stub(ctx).invoke(["itx", "facets", ["get", name, spec], [method]], [], cause);
  await facet("reviver", REVIVER, "claimNow"); // due in an hour; the test runs it sooner
  await facet("doomed", DOOMED, "claimNow");
  expect(await runDurableObjectAlarm(stub(ctx))).toBe(true); // the reviver fails: owed again
  await evictDurableObject(stub(ctx));
  // the facet's isolate last ran code in another chain
  const other = { principal: null, cause: { chain: "another chain", depth: 5 } };
  await facet("reviver", REVIVER, "touch", other);
  vi.setSystemTime(start + 24 * 60 * 60_000);
  expect(await runDurableObjectAlarm(stub(ctx))).toBe(true);
  const log = await readLog(ctx);
  expect(ofType(log, "test/revived").map(causeOf)).toEqual([{ chain: CHAIN, depth: 3 }]);
  expect(ofType(log, "events.iterate.com/itx/work-failed")).toMatchObject([
    { payload: { facet: "doomed", error: expect.stringMatching(/died with its host/) } },
  ]);
});

test("cause-table: a birth or wake takes its call's cause; past the limit, none, reads answer, one fact", async () => {
  const project = freshProject("prj_loop");
  const child = at(project, "/child");
  await stub(child).invoke("itx.whoami()", [], caller(8)); // a birth at the limit
  expect(causeOf((await readLog(child))[0]!)).toEqual({ chain: CHAIN, depth: 8 });
  expect(
    ofType(await readLog(project), "events.iterate.com/itx/child-created").map(causeOf),
  ).toEqual([{ chain: CHAIN, depth: 8 }]);
  await evictDurableObject(stub(child));
  await stub(child).invoke("itx.whoami()", [], caller(3)); // a wake
  const unborn = at(project, "/unborn");
  await refused(() => stub(unborn).invoke("itx.whoami()", [], caller(9)), "LOOP_LIMIT");
  expect(causeOf((await readLog(unborn))[0]!)).not.toMatchObject({ chain: CHAIN }); // this read bore it
  await evictDurableObject(stub(child));
  await refused(() => stub(child).invoke("itx.whoami()", [], caller(9)), "LOOP_LIMIT");
  expect(ofType(await readLog(child), WOKEN).map(causeOf)).toMatchObject([
    { chain: CHAIN, depth: 8 },
    { chain: CHAIN, depth: 3 },
    { depth: 0 }, // this read's
  ]);
  expect(await stub(child).invoke(["itx", ["readEvents", 0, 1]], [], caller(9))).toBeTruthy();
  for (let tries = 0; tries < 2; tries++)
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

test("agent-turns-one-depth: an agent's turns stay at its trigger's depth; only its scripts run one deeper", async () => {
  const ctx = freshProject("prj_loop");
  await subscribe(ctx, "agent", ["itx", "facets", ["get", "agent", AGENT], "processEventBatch"], {
    consumes: ["test/said", RUN_SETTLED],
  });
  const [spoken] = await said(ctx);
  const { chain } = causeOf(spoken!);
  const log = await until(
    "ten turns",
    async () => {
      const events = await readLog(ctx);
      return ofType(events, RUN_SETTLED).length >= 10 ? events : undefined;
    },
    60_000, // ten scripts, each in an isolate of its own
  );
  const turns = (depth: number) => Array.from({ length: 10 }, () => ({ chain, depth }));
  // each turn's parent is the event it handled: what was said, then the settlement before it
  const handled = [spoken!, ...ofType(log, RUN_SETTLED).slice(0, 9)];
  expect(ofType(log, "events.iterate.com/itx/run-requested").map(causeOf)).toEqual(
    handled.map((event) => ({ chain, depth: 0, parent: `${event.path}@${event.offset}` })),
  );
  expect(ofType(log, RUN_SETTLED).map(causeOf)).toMatchObject(turns(0));
  expect(ofType(log, "test/effect").map(causeOf)).toMatchObject(turns(1));
});

test("a read records nothing: a context read for its table, asleep or unborn, is neither woken nor born", async () => {
  const project = freshProject("prj_loop");
  const asleep = at(project, "/asleep");
  await stub(asleep).invoke(["itx", ["append", { type: "test/said" }]], [], { principal: PERSON });
  await evictDurableObject(stub(asleep));
  const before = await sweep(asleep);
  // a person's kv reads there, each resolved through that context's table (answered or not)
  for (const path of ["/asleep", "/unborn"])
    await outcome(
      stub(project).invoke(["itx", ["cd", path], "kv", ["get", "x"]], [], { principal: PERSON }),
    );
  expect(await sweep(asleep)).toEqual(before);
  expect(await sweep(at(project, "/unborn"))).toEqual([]);
});

test("a plain WorkerEntrypoint's method acts under its own call's cause, never the newest its isolate saw, through `using itx = this.getItx()`, which no caller reaches", async () => {
  const ctx = freshProject("prj_loop");
  // a main module with no default export, importing nothing from iterate
  const source = {
    "package.json": '{"main":"worker.js"}',
    "worker.js": /* js */ `
import { WorkerEntrypoint } from "cloudflare:workers";
export class NoSdkHost extends WorkerEntrypoint {
  async touch() {}
  async act() {
    using itx = this.getItx();
    await itx.append({ type: "test/no-sdk-host" });
  }
}
`,
  };
  const call = (step: unknown[], depth: number) =>
    stub(ctx).invoke(
      ["itx", "workers", ["get", { source, className: "NoSdkHost" }], step],
      [],
      caller(depth),
    );
  await call(["touch"], 5);
  await call(["act"], 1);
  expect(ofType(await readLog(ctx), "test/no-sdk-host").map(causeOf)).toEqual([
    { chain: CHAIN, depth: 1 },
  ]);
  await refused(() => call(["getItx"], 1), "NOT_A_METHOD");
});

test("a facet's callWithCause walks only as far as Workers RPC would; the shared isolate keeps no cause", async () => {
  const { projectId } = await projectWithMember("loopwalls");
  const walled = (...steps: (string | unknown[])[]) =>
    stub(projectId).invoke(["itx", "facets", ["get", "walled", WALLED], ...steps], [], caller(1));
  expect(await walled(["target"], ["open"])).toBe("opened");
  await refused(() => walled(["target"], ["secret"]), "NOT_A_METHOD");
  await refused(() => walled(["state"], "list", ["push", "x"]), "NOT_A_METHOD");
  expect(await walled(["count"])).toBe(0);
  // a first-party facet's callWithCause, run in the isolate every project shares
  const repos = (step: unknown[], cause: Cause) =>
    stub(projectId).invoke(["itx", "facets", ["get", "project"], ["repos"], step], [], {
      principal: null,
      cause,
    });
  await repos(["list"], { chain: "project A's chain", depth: 5 });
  expect(runningCause()).toBeUndefined();
  await refused(
    () => repos(["create", "/repos/deep", { creator: "/" }], caller(9).cause),
    "LOOP_LIMIT",
  );
});

// ── the loops it stops ──

test("mail from outside begins a chain; replies go out one deeper, marked, and mail back stops at the limit", async () => {
  const mailbox = await mailboxAt("loopecho");
  const sent = spyOnMail();
  await reactAtRoot(
    mailbox.inbox,
    [RECEIVED],
    `await itx.email.send({ inReplyToOffset: event.offset, text: "Thanks" });`,
  );
  const from = "ann.smith@example.com";
  await mailbox.receive({ from, messageId: "m1@example.com" });
  await mailbox.receive({ from, messageId: "m2@example.com", inReplyTo: "m1@example.com" });
  const [one, two] = ofType(await readLog(mailbox.inbox), RECEIVED).map(causeOf);
  expect(one).toEqual({ chain: expect.stringContaining(" with inbound mail ~"), depth: 0 });
  expect(two).toMatchObject({ depth: 0 });
  expect(two).not.toMatchObject({ chain: one!.chain });
  expect(one!.chain).not.toMatch(/ann/);
  // each reply comes back carrying our mark, as a copy to ourselves or an auto-reply does
  for (let echoed = 1; echoed < 20; echoed++) {
    const next = await until(
      "the next reply, or the end",
      async () =>
        ofType(await readLog(mailbox.root), LOOP_LIMIT_FACT).length > 0
          ? "stopped"
          : sent.length > echoed && "sent",
      20_000, // each reply is a delivery to loaded code
    );
    if (next === "stopped") break;
    await mailbox.receive({ from, mark: sent[echoed]!.headers[ITERATE_CAUSE_HEADER] });
  }
  expect(sent[0]!.headers).toMatchObject({ "Auto-Submitted": "auto-generated" });
  expect(sent.map(({ headers }) => JSON.parse(headers[ITERATE_CAUSE_HEADER]!).depth)).toEqual([
    1, 1, 2, 3, 4, 5, 6, 7, 8,
  ]);
  expect(ofType(await readLog(mailbox.root), LOOP_LIMIT_FACT)).toMatchObject([
    { payload: { depth: 9, error: expect.stringMatching(/itx\.email\.send refused/) } },
  ]);
});

test("a session opened with our mark resumes its chain and counts its hops: past either limit, refused", async () => {
  const project = freshProject("prj_loop");
  const outcomes = [];
  for (const [depth, hops] of [
    [8, 0],
    [9, 0],
    [1, 14],
    [1, 15],
  ] as const) {
    const opened = await exports.default.fetch(`${ORIGIN}/api`, {
      headers: { Upgrade: "websocket", [ITERATE_CAUSE_HEADER]: mark(depth, hops) },
    });
    opened.webSocket!.accept();
    const session = newWebSocketRpcSession(opened.webSocket as unknown as WebSocket) as any;
    const root = session.authenticate(adminCredentials()).projects.get(project);
    outcomes.push(await outcome(root.invoke("itx.cd('/x').append({ type: 'test/marked' })")));
    session[Symbol.dispose]();
  }
  // at 14 hops the call's `cd` is its sixteenth context; at 15, one too many
  expect(outcomes).toEqual([
    "answered",
    expect.stringMatching(/refused/),
    "answered",
    expect.stringMatching(/crossed more than 16 contexts/),
  ]);
  expect(ofType(await readLog(at(project, "/x")), "test/marked").map(causeOf)).toEqual([
    { chain: CHAIN, depth: 8 },
    { chain: CHAIN, depth: 1 },
  ]);
});

test("hop-16-throws: a re-entering request carries its hops, and a seventeenth context is refused 508", async () => {
  const request = (hops: number) =>
    exports.default.fetch(
      new Request("https://control.test/version", {
        headers: { [ITERATE_CAUSE_HEADER]: mark(1, hops) },
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
  { name: "an append in a delivery", row: delivered(`await itx.append({ type: "test/acted" });`) },
  {
    name: "a commit in a delivery",
    row: delivered(
      `await itx.repos.get("/repos/x").commitFiles({ message: "m", changes: [{ path: "a", content: "b" }] });`,
    ),
    where: "/repos/x",
  },
  {
    name: "a schedule in a delivery",
    row: delivered(
      `await itx.schedules.set({ key: "later", when: { everyMs: 60_000 }, events: [{ type: "test/acted" }] });`,
    ),
  },
  { name: "waking a sleeping context in a delivery", row: delivered(READ_THE_NEXT), sleeper: "/n" },
  {
    name: "mail in a processor's blocker",
    row: ["itx", "facets", ["get", "blocker", blocker(MAIL)], "processEventBatch"],
    mail: true,
  },
  { name: "mail in a script", script: `async (itx) => { ${MAIL} }`, mail: true },
  { name: "egress in a request", request: served(`await fetch("${ELSEWHERE}/");`) },
  {
    name: "egress through a fetch taken at load",
    request: served(`await early("${ELSEWHERE}/");`, "const early = fetch;"),
  },
  {
    name: "an append in a facet's fetch",
    request: ["itx", "facets", ["get", "acting", ACTING], "fetch"],
  },
  { name: "egress through an edge fetch route to `itx.fetch`", route: true },
])(
  "refused-act-one-fact: $name past the limit is refused and recorded once, where it was refused",
  async ({ row, script, request, route, where = "/", sleeper, mail }) => {
    const project = mail
      ? (await mailboxAt(`loopmail${script ? "script" : "row"}`)).root
      : route
        ? await routedProject()
        : freshProject("prj_loop");
    const sent = interceptOrigins({ [ELSEWHERE]: () => new Response(null) });
    const mailed = spyOnMail();
    const issues = vi.spyOn(console, "error");
    const refusedAt = at(project, where);
    await readLog(refusedAt); // awake: a call past the limit bears nothing
    const asleep = sleeper && at(project, sleeper);
    if (asleep) {
      await readLog(asleep); // born
      await evictDurableObject(stub(asleep));
    }
    const beforeWake = asleep && (await sweep(asleep));
    if (row) {
      const fanOut = row.at(-1) === "deliverEvent" ? { ordered: false } : {};
      await subscribe(project, "row", row, { consumes: ["test/said"], ...fanOut });
      await stub(project).invoke(["itx", ["append", { type: "test/said" }]], [], caller(8));
    }
    if (script) expect(await outcome(runOn(project, script, caller(8)))).toMatch(/refused/);
    if (request || route) {
      const marked = { [ITERATE_CAUSE_HEADER]: mark(9) };
      const answer = route
        ? await exports.default.fetch(`https://out--${ROUTED}.projects.test/`, { headers: marked })
        : await stub(project).fetch(
            new Request("https://project.test/", {
              headers: { "x-itx-expression": JSON.stringify(request), ...marked },
            }),
          );
      expect(answer).toMatchObject({ status: 508 });
      await answer.body?.cancel();
    }
    await until("the fact", async () => ofType(await sweep(refusedAt), LOOP_LIMIT_FACT)[0]);
    const log = await readLog(refusedAt);
    expect(ofType(log, LOOP_LIMIT_FACT)).toMatchObject([{ payload: { chain: CHAIN, depth: 9 } }]);
    expect(ofType(log, "test/acted")).toEqual([]);
    expect([...sent, ...mailed]).toEqual([]);
    if (asleep) expect(await sweep(asleep)).toEqual(beforeWake); // never woken
    expect(JSON.stringify(issues.mock.calls)).not.toMatch(/refused/);
  },
);

test.for([
  { name: "itself", next: "/" },
  { name: "the context below", next: "./n" },
])(
  "hop-17-workers: a worker calling a worker through cd, to $name, is refused at the seventeenth",
  async ({ next }) => {
    const project = freshProject("prj_loop");
    const hop = { source: config("", HOP_ON(next)) };
    const answer = await stub(project).fetch(
      new Request("https://project.test/", {
        method: "POST",
        headers: { "x-itx-expression": JSON.stringify(["itx", "workers", ["get", hop], "fetch"]) },
        body: JSON.stringify(hop),
      }),
    );
    expect(await answer.text()).toMatch(/crossed more than 16 contexts/);
    const paths =
      next === "/" ? ["/"] : Array.from({ length: 17 }, (_, n) => "/n".repeat(n) || "/");
    const levels: Cause[] = [];
    for (const path of paths)
      levels.push(...ofType(await readLog(at(project, path)), "test/level").map(causeOf));
    // a request's calls are no hand-offs: one chain at depth 0, however many
    expect(levels).toEqual(
      Array.from({ length: 17 }, () => ({ chain: levels[0]!.chain, depth: 0 })),
    );
    expect(levels[0]!.chain).toContain(" with a request ~");
  },
);

// ── helpers ──

/** A caller in the middle of CHAIN, `depth` hand-offs deep. */
function caller(depth: number) {
  return { principal: null, cause: { chain: CHAIN, depth } };
}

/** Our mark on a request, `depth` into CHAIN. */
function mark(depth: number, hops = 0) {
  return JSON.stringify({ chain: CHAIN, depth, hops });
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

/** The cause an event was stored with. */
function causeOf(event: StreamEvent): Cause {
  return event.source!.cause!;
}

function ofType(events: StreamEvent[], type: string) {
  return events.filter((event) => event.type === type);
}

/** The first `type` on `ctx`'s log, once there is one. */
function eventually(ctx: string, type: string, timeoutMs?: number) {
  return until(`${type} on ${ctx}`, async () => ofType(await readLog(ctx), type)[0], timeoutMs);
}

/** How a call settled, as text: a plain handler, since `.rejects` attaches a tick late to a
 *  rejected RPC promise, which reports it unhandled (facets.test.ts). */
function outcome(call: unknown) {
  return (call as Promise<unknown>).then(
    () => "answered",
    (error: unknown) => String(error),
  );
}

/** A fan-out target that hands each event to `config(onEvent)`, loaded at the row's context or,
 *  with `["cd", "/"]`, at the project's root. */
function delivered(onEvent: string, at: unknown[] = []) {
  return ["itx", ...at, "workers", ["get", { source: config(onEvent) }], "deliverEvent"];
}

/** A request's expression: `config`'s fetch, running `onRequest` after `preamble`. */
function served(onRequest: string, preamble = "") {
  return ["itx", "workers", ["get", { source: config("", onRequest, preamble) }], "fetch"];
}

/** A loaded config entrypoint (iterate/sdk): `processEvent` runs `onEvent`, `fetch` runs
 *  `onRequest`, after `preamble` at module scope; `later()`, no hook, appends `test/later`. */
function config(onEvent: string, onRequest = "", preamble = "") {
  return {
    "package.json": '{"main":"worker.js"}',
    "worker.js": /* js */ `
import { IterateConfigEntrypoint } from "iterate/sdk";
${preamble}
export default class extends IterateConfigEntrypoint {
  async processEvent({ event, itx }) {
    ${onEvent}
  }
  async fetch(request) {
    using itx = this.getItx();
    ${onRequest}
    return new Response("served");
  }
  async later() {
    using itx = this.getItx();
    await itx.append({ type: "test/later" });
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

/** A loaded facet class `name` (iterate/sdk FacetDurableObject) listing `methods`, its body `body`. */
function facetSpec(name: string, methods: string[], body: string, preamble = "") {
  return {
    source: {
      "package.json": '{"main":"worker.js"}',
      "worker.js": /* js */ `
import { FacetDurableObject } from "iterate/sdk";
${preamble}
export class ${name} extends FacetDurableObject {
  static publicMethods = [...super.publicMethods, ...${JSON.stringify(methods)}];
  ${body}
}
`,
    },
    className: name,
  };
}

/** A facet whose claim (`claimNow`, due in an hour) is revived once in vain, then appends
 *  `test/revived`; `touch` does nothing. */
const REVIVER = facetSpec(
  "Reviver",
  ["claimNow", "touch"],
  /* js */ `
  touch() {}
  async claimNow() {
    using itx = this.getItx();
    return await itx.processors.claim("reviver", Date.now() + 3_600_000);
  }
  async revive() {
    const tries = (this.ctx.storage.kv.get("tries") ?? 0) + 1;
    this.ctx.storage.kv.put("tries", tries);
    if (tries === 1) throw new Error("the first revive fails");
    using itx = this.getItx();
    await itx.append({ type: "test/revived" });
  }`,
);

/** A facet whose claim's work has died with its host too often: its revive is refused, as the
 *  SDK's engine refuses it. */
const DOOMED = facetSpec(
  "Doomed",
  ["claimNow"],
  /* js */ `
  async claimNow() {
    using itx = this.getItx();
    return await itx.processors.claim("doomed", Date.now() + 3_600_000);
  }
  revive() {
    throw Object.assign(new Error("its work in flight died with its host 5 times"), { code: "PERMANENT_FAILURE" });
  }`,
);

/** A facet that hands out an RpcTarget with a field of its own (`target()`) and the list it keeps,
 *  live (`state()`), and counts that list (`count()`). */
const WALLED = facetSpec(
  "Walled",
  ["target", "state", "count"],
  /* js */ `
  #list = [];
  target() { return new Target(() => "the facet's own"); }
  state() { return { list: this.#list }; }
  count() { return this.#list.length; }`,
  /* js */ `
import { RpcTarget } from "cloudflare:workers";
class Target extends RpcTarget {
  constructor(secret) { super(); this.secret = secret; }
  open() { return "opened"; }
}`,
);

/** A loaded processor `slug` on `consumes`, its StreamProcessor's body `body`; `this.getItx` is
 *  its host's. */
function processorSpec(slug: string, consumes: string[], body: string, state = "z.object({})") {
  return {
    source: {
      "package.json": '{"main":"worker.js"}',
      "worker.js": /* js */ `
import { StreamProcessorDurableObject } from "iterate/sdk";
import { StreamProcessor, defineProcessorContract } from "iterate/stream/processor";
import { z } from "zod";
class Processor extends StreamProcessor {
  contract = defineProcessorContract({ slug: "${slug}", version: "1.0.0", description: "${slug}", stateSchema: ${state}, consumes: ${JSON.stringify(consumes)}, emits: ["events.iterate.com/itx/run-requested"] });
  constructor(getItx) { super(); this.getItx = getItx; }
  ${body}
}
export class ProcessorDurableObject extends StreamProcessorDurableObject {
  processor = new Processor(() => this.getItx());
}`,
    },
    className: "ProcessorDurableObject",
  };
}

/** A processor that runs `code` in a blocker on each `test/said`. */
function blocker(code: string) {
  return processorSpec(
    "blocker",
    ["test/said"],
    `processEvent({ event, blockProcessorWhile }) { if (event) blockProcessorWhile(async () => { using itx = this.getItx(); ${code} }); }`,
  );
}

/** An agent's loop, its model left out: a run on `test/said` and on each settlement, ten turns,
 *  each script appending `test/effect`. */
const AGENT = processorSpec(
  "agent",
  ["test/said", RUN_SETTLED],
  /* js */ `
  reduce({ event, state }) {
    if (event.type === "${RUN_SETTLED}") return { turns: state.turns + 1 };
  }
  processEvent({ event, state, append, blockProcessorWhile }) {
    if (!event || state.turns >= 10) return;
    blockProcessorWhile(() =>
      append({
        type: "events.iterate.com/itx/run-requested",
        idempotencyKey: this.idempotencyKey("turn", event),
        payload: { code: "async (itx) => { await itx.append({ type: 'test/effect' }); }" },
      }),
    );
  }`,
  "z.object({ turns: z.number().default(0) })",
);

/** `ctx`'s subscription row `name` to `target`. */
function subscribe(ctx: string, name: string, target: unknown[], row: object) {
  return stub(ctx).append({
    type: "events.iterate.com/itx/subscription-configured",
    payload: { name, target, ...row },
  });
}

/** `ctx`'s fan-out row `react`: each event of `consumes` to `config(onEvent)`, loaded at `ctx` or,
 *  with `["cd", "/"]`, at the project's root. */
function react(ctx: string, consumes: string[], onEvent: string, at: unknown[] = []) {
  return subscribe(ctx, "react", delivered(onEvent, at), { consumes, ordered: false });
}

/** `react`, its handler loaded at the project's root, where `itx.email` is. */
function reactAtRoot(ctx: string, consumes: string[], onEvent: string) {
  return react(ctx, consumes, onEvent, [["cd", "/"]]);
}

/** ROUTED's root, whose edge fetch route `out` forwards every request to `itx.fetch`. */
async function routedProject() {
  const itx = (await openSession())
    .authenticate(adminCredentials())
    .projects.create({ project: ROUTED });
  await itx.fetchRoutes.set("out", { requestMatcher: { routingSlug: "out" }, target: "itx.fetch" });
  return ((await itx.whoami()) as { projectId: string }).projectId;
}

/** A project with an address, `<slug>@projects.test`: its root, its `/integrations/email`, and mail
 *  to it from outside, or carrying our mark as mail we sent that comes back does. */
async function mailboxAt(slug: string) {
  const { projectId } = await projectWithMember(slug);
  let n = 0;
  return {
    root: projectId,
    inbox: at(projectId, "/integrations/email"),
    receive: (mail: { from: string; messageId?: string; inReplyTo?: string; mark?: string }) =>
      deliverMail(
        `${slug}@projects.test`,
        [
          `From: ${mail.from}`,
          `To: ${slug}@projects.test`,
          "Subject: Hello",
          `Message-ID: <${mail.messageId || `${slug}-${++n}@example.com`}>`,
          ...(mail.inReplyTo ? [`In-Reply-To: <${mail.inReplyTo}>`] : []),
          ...(mail.mark ? [`X-Iterate-Cause: ${mail.mark}`, "Auto-Submitted: auto-generated"] : []),
          "",
          "Hello there.",
        ].join("\r\n"),
        { from: mail.from },
      ),
  };
}

/** Every message the mail binding is asked to send, its headers as sent: taken there, never sent
 *  on; with `refuseFirst`, the first is refused, as the binding refuses one, and not sent. */
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
