// __workers-tests__/fan-out-targets.test.ts — WHAT A FAN-OUT ROW'S TARGET MAY BE, inside workerd:
// only the delivery loop's own call, the one carrying the log's event, runs with delivery authority,
// and only for that event (caller.ts `Caller.delivery`, its digest). A target that binds
// `deliverEvent` to an event of its own — at its end, midway, behind a rule, or in a rule another
// context expands inside the delivery's call — is refused, so neither a loaded worker nor a webhook
// ever sees the forged event; a target in another context (`cd`) still receives the real one; and
// the public `subscribe({ ordered: false })` makes a fan-out row. The fan-out semantics:
// src/stream/subscription-delivery.test.ts.
import { expect, test, vi } from "vitest";
import type { ItxExpression } from "iterate/expression";
import type { StreamEvent } from "iterate/stream/processor";
import { adminCredentials, openSession, PERSON, readLog, refused, stub, until } from "./support.ts";

const HOOKS = "https://hooks.test";

/** An event the target's author wrote, not the log. */
const FORGED = { type: "test/forged", offset: 999, path: "/x", payload: { from: "the target" } };

test("deliverEvent and processEvent answer the delivery loop alone: loaded code, a session and a principal-less caller are FORBIDDEN", async () => {
  const project = freshProject();
  const worker = ["itx", "workers", ["get", { source: recordingWorker() }]];
  for (const target of [
    [...worker, ["deliverEvent", FORGED]],
    [...worker, ["processEvent", FORGED]],
    ["itx", "webhooks", ["get", { url: `${HOOKS}/in` }], ["deliverEvent", FORGED]],
    ["itx", "builtins", "platformHook", ["deliverEvent", FORGED]],
  ])
    for (const caller of [
      { principal: null, app: true as const },
      { principal: PERSON },
      { principal: null },
    ])
      // loaded code may not spell itx.builtins at all, a wall of its own
      if (!("app" in caller && target[1] === "builtins"))
        await refused(
          () => stub(project).invoke(target as ItxExpression, [], caller),
          "FORBIDDEN",
          /is the delivery loop's own call/,
        );
  expect(await recorded(project)).toEqual([]);
});

test.for([
  {
    name: "bound at the target's end",
    target: (worker: ItxExpression[number]) => ["itx", "workers", worker, ["deliverEvent", FORGED]],
  },
  {
    name: "bound midway, the row's own method after it",
    target: (worker: ItxExpression[number]) => [
      "itx",
      "workers",
      worker,
      ["deliverEvent", FORGED],
      "deliverEvent",
    ],
  },
])(
  "a loaded worker's deliverEvent $name is refused while the target is evaluated: the row halts, the worker never sees the forged event",
  async ({ target }) => {
    const project = freshProject();
    const x = `${project}.iterate/x`;
    await configure(x, target(["get", { source: recordingWorker() }]) as ItxExpression);
    await stub(x).append({ type: "test/real", payload: {} });
    const halted = await haltOf(x);
    expect(halted.error).toContain("deliverEvent is the delivery loop's own call");
    expect(await recorded(project)).toEqual([]);
  },
);

test("a rule that binds deliverEvent to an event of its own is refused the same way: the row halts", async () => {
  const project = freshProject();
  const x = `${project}.iterate/x`;
  await stub(x).append({
    type: "events.iterate.com/itx/rewrite-rule-configured",
    payload: {
      match: "itx.hook",
      target: ["itx", "workers", ["get", { source: recordingWorker() }], ["deliverEvent", FORGED]],
    },
  });
  await configure(x, ["itx", "hook"]);
  await stub(x).append({ type: "test/real", payload: {} });
  expect((await haltOf(x)).error).toContain("deliverEvent is the delivery loop's own call");
  expect(await recorded(project)).toEqual([]);
});

test("a webhook's deliverEvent bound to an event of its own is refused before any POST: the receiver sees nothing", async () => {
  const requests: string[] = [];
  const through = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).origin !== HOOKS) return through(request);
    requests.push(await request.text());
    return new Response(null, { status: 200 });
  });
  const x = `${freshProject()}.iterate/x`;
  await configure(x, [
    "itx",
    "webhooks",
    ["get", { url: `${HOOKS}/in` }],
    ["deliverEvent", FORGED],
  ]);
  await stub(x).append({ type: "test/real", payload: {} });
  expect((await haltOf(x)).error).toContain("deliverEvent is the delivery loop's own call");
  expect(requests).toEqual([]);
});

const WEBHOOK = ["itx", "webhooks", ["get", { url: `${HOOKS}/in` }], "deliverEvent"];

test.for([
  {
    name: "a trailing call step",
    forged: [...WEBHOOK, ["bind", null, FORGED]],
    honest: WEBHOOK,
  },
  {
    name: "the same through cd('/y')",
    forged: ["itx", ["cd", "/y"], ...WEBHOOK.slice(1), ["bind", null, FORGED]],
    honest: ["itx", ["cd", "/y"], ...WEBHOOK.slice(1)],
  },
  {
    name: "a relay rule at /y",
    rules: {
      "itx.forgingRelay": [...WEBHOOK.slice(0, -1), ["deliverEvent", FORGED]],
      "itx.relay": WEBHOOK,
    },
    forged: ["itx", ["cd", "/y"], "forgingRelay"],
    honest: ["itx", ["cd", "/y"], "relay"],
  },
])(
  "a webhook handed an event of the target's own through $name POSTs nothing — the rule's call runs inside the delivery's and is still refused — and the log's own event arrives through the honest spelling",
  async ({ rules, forged, honest }) => {
    const bodies: string[] = [];
    const through = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).origin !== HOOKS) return through(request);
      bodies.push(await request.text());
      return new Response(null, { status: 200 });
    });
    const project = freshProject();
    const x = `${project}.iterate/x`;
    // each webhook sends through its context's `fetch`, the project root's, granted by a rule
    const fetchGrant = { "itx.fetch": "itx.builtins.cd('/').fetch" };
    for (const [ctx, ctxRules] of [
      ["x", fetchGrant],
      ["y", { ...fetchGrant, ...rules }],
    ] as const)
      for (const [match, target] of Object.entries(ctxRules))
        await stub(`${project}.iterate/${ctx}`).append({
          type: "events.iterate.com/itx/rewrite-rule-configured",
          payload: { match, target },
        });
    await configure(x, forged as ItxExpression, "forged");
    await configure(x, honest as ItxExpression, "honest");
    const [real] = (await stub(x).append({
      type: "test/real",
      payload: {},
    })) as unknown as StreamEvent[];
    await until("the forged row's call failed", async () => {
      const row = (await stub(x).invoke("itx.subscriptions.get('forged')")) as {
        halted?: unknown;
        pending?: number;
      };
      return row.halted || row.pending === 1 || undefined;
    });
    await until("the real event posted", () => (bodies.length > 0 ? true : undefined));
    expect(bodies.map((body) => JSON.parse(body))).toMatchObject([
      { type: "test/real", path: "/x", offset: real!.offset },
    ]);
  },
);

test("a loaded handler's own refusal fails only its event: one calling a name nothing resolves and one calling a verb it may not are retried on their ladders, and the events around them are delivered", async () => {
  const project = freshProject();
  const x = `${project}.iterate/x`;
  await configure(x, ["itx", "workers", ["get", { source: refusingWorker() }], "deliverEvent"]);
  for (let n = 1; n <= 5; n++) await stub(x).append({ type: "test/real", payload: { n } });
  await until("1, 4 and 5 delivered", async () =>
    (await recorded(project)).length === 3 ? true : undefined,
  );
  const row = await until("2 and 3 pending their retries", async () => {
    const view = (await stub(x).invoke("itx.subscriptions.get('f')")) as { pending?: number };
    return view.pending === 2 ? view : undefined;
  });
  expect(row).not.toHaveProperty("halted");
  const delivered = (await recorded(project)) as { payload: { n: number } }[];
  expect(delivered.map(({ payload }) => payload.n).toSorted()).toEqual([1, 4, 5]);
});

test("a target in another context (`itx.cd('/y')…deliverEvent`) is handed the log's own event, with the delivery's authority across the hop", async () => {
  const project = freshProject();
  const x = `${project}.iterate/x`;
  await configure(x, [
    "itx",
    ["cd", "/y"],
    "workers",
    ["get", { source: recordingWorker() }],
    "deliverEvent",
  ]);
  const [real] = (await stub(x).append({
    type: "test/real",
    payload: {},
  })) as unknown as StreamEvent[];
  await until("the event reached the worker", async () =>
    (await recorded(project)).length > 0 ? true : undefined,
  );
  expect(await recorded(project)).toMatchObject([
    { type: "test/real", path: "/x", offset: real!.offset },
  ]);
});

test("the public subscribe({ ordered: false }) makes a fan-out row: `itx.subscriptions` says so, and each event reaches the webhook alone", async () => {
  const posted: string[] = [];
  const through = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).origin !== HOOKS) return through(request);
    posted.push(request.headers.get("iterate-event-id") ?? "");
    return new Response(null, { status: 200 });
  });
  const project = freshProject();
  const itx = await (await openSession()).authenticate(adminCredentials()).projects.get(project);
  await itx.subscribe({
    name: "hook",
    target: ["itx", "webhooks", ["get", { url: `${HOOKS}/in` }], "deliverEvent"],
    consumes: ["test/real"],
    ordered: false,
  });
  expect(await itx.subscriptions.get("hook")).toMatchObject({ ordered: false, pending: 0 });
  const appended = (await stub(project).append(
    { type: "test/real", payload: { n: 1 } },
    { type: "test/real", payload: { n: 2 } },
  )) as unknown as StreamEvent[];
  await until("both events posted", () => (posted.length === 2 ? true : undefined));
  expect(posted.toSorted()).toEqual(
    appended.map(({ offset }) => `${project}/@${offset}`).toSorted(),
  );
});

/** A worker whose `deliverEvent` records every event it is handed on the project's `/sink`. */
function recordingWorker() {
  return {
    "package.json": '{"main":"worker.js"}',
    "worker.js": /* js */ `
import { WorkerEntrypoint } from "cloudflare:workers";
import { withItx } from "iterate/with-itx";
export default class Recorder extends WorkerEntrypoint {
  deliverEvent(event) {
    return withItx(this.env.ITX, (itx) =>
      itx.cd("/sink").append({ type: "test/recorded", payload: event }),
    );
  }
}
`,
  };
}

/** A worker whose `deliverEvent` records its event like `recordingWorker`'s, but first, for ping 2,
 *  calls a name nothing resolves, and for ping 3, a verb loaded code may not call. */
function refusingWorker() {
  return {
    "package.json": '{"main":"worker.js"}',
    "worker.js": /* js */ `
import { WorkerEntrypoint } from "cloudflare:workers";
import { withItx } from "iterate/with-itx";
export default class Refuser extends WorkerEntrypoint {
  deliverEvent(event) {
    return withItx(this.env.ITX, async (itx) => {
      if (event.payload.n === 2) await itx.nope();
      if (event.payload.n === 3)
        await itx.webhooks.get({ url: "${HOOKS}/in" }).deliverEvent(event);
      await itx.cd("/sink").append({ type: "test/recorded", payload: event });
    });
  }
}
`,
  };
}

/** `ctx`'s fan-out row `name` (default `f`) on `target`, taking `test/real`. */
async function configure(ctx: string, target: ItxExpression, name = "f") {
  await stub(ctx).append({
    type: "events.iterate.com/itx/subscription-configured",
    payload: { name, target, consumes: ["test/real"], ordered: false },
  });
}

/** Every event a recording worker of `project` was handed. */
async function recorded(project: string) {
  return (await readLog(`${project}.iterate/sink`))
    .filter((event) => event.type === "test/recorded")
    .map((event) => event.payload);
}

/** Wait for `ctx`'s row `f` to halt, and answer why. */
async function haltOf(ctx: string) {
  return until(`${ctx}'s row halted`, async () => {
    const row = (await stub(ctx).invoke("itx.subscriptions.get('f')")) as {
      halted?: { error?: string };
    };
    return row.halted;
  });
}

function freshProject() {
  return `prj_targets_${crypto.randomUUID().slice(0, 8)}`;
}
