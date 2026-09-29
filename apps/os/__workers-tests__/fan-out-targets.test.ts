// Who may call a fan-out target's deliverEvent, with which event; semantics: subscription-delivery.test.ts
import { expect, test } from "vitest";
import type { ItxExpression } from "iterate/expression";
import type { StreamEvent } from "iterate/stream/processor";
import { deliverEventWorker } from "./sources.ts";
import {
  adminCredentials,
  at,
  freshProject,
  interceptOrigins,
  openSession,
  PERSON,
  readLog,
  refused,
  rowOf,
  rule,
  stub,
  until,
} from "./support.ts";

const HOOKS = "https://hooks.test";
/** An event the target's author wrote, not the log. */
const FORGED = { type: "test/forged", offset: 999, path: "/x", payload: { from: "the target" } };
const WORKER = ["itx", "workers", ["get", { source: recordingWorker() }]];
const WEBHOOK = ["itx", "webhooks", ["get", { url: `${HOOKS}/in` }], "deliverEvent"];
/** Each webhook sends through its context's `fetch`, the project root's, granted by this rule. */
const FETCH_GRANT = rule("itx.fetch", "itx.builtins.cd('/').fetch");

test("deliverEvent and processEvent answer the delivery loop alone: every other caller is FORBIDDEN", async () => {
  const project = freshProject();
  for (const target of [
    [...WORKER, ["deliverEvent", FORGED]],
    [...WORKER, ["processEvent", FORGED]],
    [...WEBHOOK.slice(0, -1), ["deliverEvent", FORGED]],
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
  { name: "a worker's, bound at the target's end", target: [...WORKER, ["deliverEvent", FORGED]] },
  {
    name: "a worker's, bound midway",
    target: [...WORKER, ["deliverEvent", FORGED], "deliverEvent"],
  },
  {
    name: "a worker's, bound by a rule",
    rule: [...WORKER, ["deliverEvent", FORGED]],
    target: ["itx", "hook"],
  },
  {
    name: "a webhook's, bound at the target's end",
    target: [...WEBHOOK.slice(0, -1), ["deliverEvent", FORGED]],
  },
])(
  "deliverEvent $name to an event of the target's own is refused: the row halts, nothing receives it",
  async ({ rule: hook, target }) => {
    const posted = interceptOrigins({ [HOOKS]: () => new Response(null) });
    const project = freshProject();
    const x = at(project, "/x");
    if (hook) await stub(x).append(rule("itx.hook", hook));
    await configure(x, target as ItxExpression);
    await stub(x).append({ type: "test/real", payload: {} });
    const halted = await until(`${x}'s row halted`, async () => (await rowOf(x, "f"))?.halted);
    expect(halted.error).toContain("deliverEvent is the delivery loop's own call");
    expect({ recorded: await recorded(project), posted }).toEqual({ recorded: [], posted: [] });
  },
);

test.for([
  { name: "a trailing call step", forged: [...WEBHOOK, ["bind", null, FORGED]], honest: WEBHOOK },
  {
    name: "the same through cd('/y')",
    forged: ["itx", ["cd", "/y"], ...WEBHOOK.slice(1), ["bind", null, FORGED]],
    honest: ["itx", ["cd", "/y"], ...WEBHOOK.slice(1)],
  },
  {
    name: "a relay rule at /y",
    rules: [
      rule("itx.forgingRelay", [...WEBHOOK.slice(0, -1), ["deliverEvent", FORGED]]),
      rule("itx.relay", WEBHOOK),
    ],
    forged: ["itx", ["cd", "/y"], "forgingRelay"],
    honest: ["itx", ["cd", "/y"], "relay"],
  },
])(
  "a forged event through $name POSTs nothing, and the log's own event arrives through the honest spelling",
  async ({ rules = [], forged, honest }) => {
    const bodies: string[] = [];
    interceptOrigins({
      [HOOKS]: async (request) => {
        bodies.push(await request.text());
        return new Response(null);
      },
    });
    const project = freshProject();
    const x = at(project, "/x");
    await stub(x).append(FETCH_GRANT);
    await stub(at(project, "/y")).append(FETCH_GRANT, ...rules);
    await configure(x, forged as ItxExpression, "forged");
    await configure(x, honest as ItxExpression, "honest");
    await stub(x).append({ type: "test/real", payload: {} });
    await until("the forged row's call failed", async () => {
      const row = await rowOf(x, "forged");
      return row?.halted || row?.pending === 1;
    });
    await until("the real event posted", () => bodies.length > 0);
    expect(bodies.map((body) => JSON.parse(body))).toMatchObject([
      { type: "test/real", path: "/x" },
    ]);
  },
);

test("a handler's own refusal fails only its event: it retries on its ladder, the events around it are delivered", async () => {
  // event 3's webhook would post if loaded code's deliverEvent were not refused
  interceptOrigins({ [HOOKS]: () => new Response(null) });
  const project = freshProject();
  const x = at(project, "/x");
  await stub(x).append(FETCH_GRANT);
  await configure(x, ["itx", "workers", ["get", { source: REFUSING_WORKER }], "deliverEvent"]);
  for (let n = 1; n <= 5; n++) await stub(x).append({ type: "test/real", payload: { n } });
  await until("1, 4 and 5 delivered", async () => (await recorded(project)).length === 3);
  const row = await until("2 and 3 pending their retries", async () => {
    const row = await rowOf(x, "f");
    return row?.pending === 2 && row;
  });
  expect(row).not.toHaveProperty("halted");
  expect((await recorded(project)).map(({ payload }) => payload.n).toSorted()).toEqual([1, 4, 5]);
});

test("the public subscribe({ ordered: false }) makes a fan-out row", async () => {
  const project = freshProject();
  const itx = await (await openSession()).authenticate(adminCredentials()).projects.get(project);
  await itx.subscribe({ name: "hook", target: WEBHOOK, consumes: ["test/real"], ordered: false });
  expect(await rowOf(project, "hook")).toMatchObject({ ordered: false, pending: 0 });
});

/** A worker whose `deliverEvent` runs `before`, then records its event on the project's `/sink`. */
function recordingWorker(before = "") {
  return deliverEventWorker(/* js */ `
      ${before}
      await itx.cd("/sink").append({ type: "test/recorded", payload: event });
`);
}

/** A recording worker that, for event 2, first calls a name nothing resolves, and for event 3, a
 *  verb loaded code may not call. */
const REFUSING_WORKER = recordingWorker(/* js */ `
      if (event.payload.n === 2) await itx.nope();
      if (event.payload.n === 3) await itx.webhooks.get({ url: "${HOOKS}/in" }).deliverEvent(event);
`);

/** `ctx`'s fan-out row `name` (default `f`) on `target`, taking `test/real`. */
async function configure(ctx: string, target: ItxExpression, name = "f") {
  await stub(ctx).append({
    type: "events.iterate.com/itx/subscription-configured",
    payload: { name, target, delivery: "durable", consumes: ["test/real"], ordered: false },
  });
}

/** Every event a recording worker of `project` was handed. */
async function recorded(project: string) {
  return (await readLog(at(project, "/sink")))
    .filter(({ type }) => type === "test/recorded")
    .map(({ payload }) => payload as StreamEvent & { payload: { n?: number } });
}
