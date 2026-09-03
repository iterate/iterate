// bench/api.bench.ts — THE scenarios, each a client-perceived number over capnweb at /api (what a
// product client sees) unless it says FETCH LANE (one HTTP request per call, so the deployed
// worker's tail attributes cpuTime/wallTime per call — bench/tail-summary.ts). Every scenario
// names what it isolates:
//   boot      — a FRESH context's first call (DO constructor + created/woken + core state) on a warm
//               session, against the warm-context round trip beneath it
//   latency   — the steady round trips: built-in, durable append, ephemeral append, read, rule chain
//   throughput— appends per second, pipelined and batched
//   delivery  — append → a lent callback's push (the push lane) and → a processor's reduce (the facet lane)
//   facet     — a processor's COLD materialization on a fresh context (loader + class + first call)

import { bench, describe } from "vitest";
import { freshCtx, openItx, session, sleep, workerUrl } from "../e2e/support/client.ts";
import { enableFixtureProcessor } from "../e2e/support/sources.ts";

const TIME = Number(process.env.BENCH_TIME_MS ?? 4000);
const opts = { time: TIME, warmupTime: 500, warmupIterations: 2 };

const invoke = (itx: any, expression: unknown) => itx.invoke(expression);
const fetchLane = async (ctx: string, itxExpression: string): Promise<unknown> => {
  const u = new URL("/expression", workerUrl("/"));
  u.searchParams.set("context", ctx);
  u.searchParams.set("itx", itxExpression);
  const r = await fetch(u);
  return r.text();
};

describe("boot", () => {
  let s: any;
  const warm = { itx: undefined as any };
  bench(
    "fresh context, first whoami (warm session)",
    async () => {
      await invoke(s.authenticate().projects.get(freshCtx("boot")), ["itx", ["whoami"]]);
    },
    {
      ...opts,
      setup: () => {
        s ??= session();
      },
    },
  );
  bench(
    "warm context, whoami (the round trip beneath boot)",
    async () => {
      await invoke(warm.itx, ["itx", ["whoami"]]);
    },
    {
      ...opts,
      setup: async () => {
        if (!warm.itx) {
          warm.itx = openItx(freshCtx("warm"));
          await invoke(warm.itx, ["itx", ["whoami"]]);
        }
      },
    },
  );
  bench(
    "FETCH LANE fresh context, whoami (one HTTP request → one tail event)",
    async () => {
      await fetchLane(freshCtx("bootfetch"), "itx.whoami()");
    },
    opts,
  );
  bench(
    "FETCH LANE warm context, whoami",
    async () => {
      await fetchLane("prj_benchwarmfetch", "itx.whoami()");
    },
    opts,
  );
});

describe("latency", () => {
  const w = { itx: undefined as any };
  const ready = async () => {
    if (!w.itx) {
      w.itx = openItx(freshCtx("lat"));
      await invoke(w.itx, ["itx", ["whoami"]]);
      await w.itx.provide("itx.alias", "itx.kv"); // a one-rule chain onto a built-in
    }
  };
  bench(
    "durable append, 1 event",
    async () => {
      await invoke(w.itx, ["itx", ["append", { type: "bench/ping", payload: { n: 1 } }]]);
    },
    { ...opts, setup: ready },
  );
  bench(
    "ephemeral append, 1 event",
    async () => {
      await invoke(w.itx, ["itx", ["append", { type: "bench/blip", ephemeral: true }]]);
    },
    { ...opts, setup: ready },
  );
  bench(
    "read 100",
    async () => {
      await invoke(w.itx, ["itx", ["read", 0, 100]]);
    },
    { ...opts, setup: ready },
  );
  bench(
    "kv.get through a rewrite rule (itx.alias.get)",
    async () => {
      await invoke(w.itx, ["itx", "alias", ["get", "nope"]]);
    },
    { ...opts, setup: ready },
  );
  bench(
    "core snapshot (itx.facets.get('core').snapshot())",
    async () => {
      await invoke(w.itx, ["itx", "facets", ["get", "core"], ["snapshot"]]);
    },
    { ...opts, setup: ready },
  );
  bench(
    "FETCH LANE durable append, 1 event",
    async () => {
      await fetchLane("prj_benchlatfetch", "itx.append({ type: 'bench/ping', payload: { n: 1 } })");
    },
    opts,
  );
});

describe("throughput", () => {
  const w = { itx: undefined as any };
  const ready = async () => {
    if (!w.itx) {
      w.itx = openItx(freshCtx("thr"));
      await invoke(w.itx, ["itx", ["whoami"]]);
    }
  };
  bench(
    "100 single-event appends in flight (pipelined)",
    async () => {
      await Promise.all(
        Array.from({ length: 100 }, (_, i) =>
          invoke(w.itx, ["itx", ["append", { type: "bench/ping", payload: { i } }]]),
        ),
      );
    },
    { ...opts, setup: ready },
  );
  bench(
    "1 append of 100 events (batched)",
    async () => {
      await invoke(w.itx, [
        "itx",
        [
          "append",
          ...Array.from({ length: 100 }, (_, i) => ({ type: "bench/ping", payload: { i } })),
        ],
      ]);
    },
    { ...opts, setup: ready },
  );
  bench(
    "100 ephemeral appends in flight",
    async () => {
      await Promise.all(
        Array.from({ length: 100 }, (_, i) =>
          invoke(w.itx, [
            "itx",
            ["append", { type: "bench/blip", ephemeral: true, payload: { i } }],
          ]),
        ),
      );
    },
    { ...opts, setup: ready },
  );
});

describe("delivery", () => {
  const push = { itx: undefined as any, waiters: [] as (() => void)[] };
  const readyPush = async () => {
    if (!push.itx) {
      push.itx = openItx(freshCtx("push"));
      await push.itx.subscribe({
        name: "bench-sink",
        target: (events: unknown[]) => {
          for (const _ of events) push.waiters.shift()?.();
        },
        consumes: ["bench/ping"],
      });
    }
  };
  bench(
    "append → lent callback push (round trip through the DO and back)",
    async () => {
      const delivered = new Promise<void>((r) => push.waiters.push(r));
      await invoke(push.itx, ["itx", ["append", { type: "bench/ping", payload: { n: 1 } }]]);
      await delivered;
    },
    { ...opts, setup: readyPush },
  );

  const facet = { itx: undefined as any, n: 0 };
  const readyFacet = async () => {
    if (!facet.itx) {
      facet.itx = openItx(freshCtx("tally"));
      await enableFixtureProcessor(facet.itx, "tally");
      await facet.itx.invoke(
        `itx.facets.get('tally').waitUntilProcessed({ offset: 1, timeoutMs: 20000 })`,
      );
    }
  };
  bench(
    "append → processor reduced (waitUntilProcessed on the tally facet)",
    async () => {
      const [e] = await invoke(facet.itx, [
        "itx",
        ["append", { type: "bench/ping", payload: { n: 1 } }],
      ]);
      await invoke(facet.itx, [
        "itx",
        "facets",
        ["get", "tally"],
        ["waitUntilProcessed", { offset: e.offset, timeoutMs: 20000 }],
      ]);
    },
    { ...opts, setup: readyFacet },
  );
  bench(
    "warm facet snapshot (itx.facets.get('tally').snapshot())",
    async () => {
      await invoke(facet.itx, ["itx", "facets", ["get", "tally"], ["snapshot"]]);
    },
    { ...opts, setup: readyFacet },
  );
});

describe("facet cold start", () => {
  let s: any;
  bench(
    "fresh context: enableProcessor(tally) + first waitUntilProcessed (cold loader + class + first call)",
    async () => {
      const itx = s.authenticate().projects.get(freshCtx("cold"));
      await enableFixtureProcessor(itx, "tally");
      await itx.invoke(
        `itx.facets.get('tally').waitUntilProcessed({ offset: 1, timeoutMs: 30000 })`,
      );
    },
    {
      ...opts,
      setup: () => {
        s ??= session();
      },
    },
  );
});

// keep the module's sleep import used for future pacing scenarios
void sleep;
