// The metrics copy's decisions: which hours it copies, a data point as a `metrics` row, and the
// chunks it sends. The reads and sends themselves are proven against the dev account.
import { expect, test } from "vitest";
import { chunks, COPY_HOURS, hoursToCopy, metricsRows, type MetricsRow } from "./metrics-copy.ts";
import { analyticsEngineRows } from "./telemetry.ts";

const HOUR = 3_600;
const H0 = 1_790_769_600; // 2026-09-30T12:00:00Z

test.for<{ name: string; analyticsEngine: number[]; lake: number[]; hours: number[] }>([
  {
    name: "the hours with points the lake lacks, newest first",
    analyticsEngine: [H0, H0 + HOUR, H0 + 2 * HOUR],
    lake: [H0 + HOUR],
    hours: [H0 + 2 * HOUR, H0],
  },
  {
    name: "an hour the lake has any row of is never copied again",
    analyticsEngine: [H0],
    lake: [H0],
    hours: [],
  },
  {
    name: "a gap longer than a run's cap copies its newest hours first",
    analyticsEngine: Array.from({ length: COPY_HOURS + 6 }, (_, index) => H0 + index * HOUR),
    lake: [],
    hours: Array.from({ length: COPY_HOURS }, (_, index) => H0 + (COPY_HOURS + 5 - index) * HOUR),
  },
])("$name", ({ analyticsEngine, lake, hours }) => {
  expect(hoursToCopy(analyticsEngine, new Set(lake))).toEqual(hours);
});

test.for<{ name: string; point: Record<string, unknown>; row: MetricsRow }>([
  {
    name: "a point is a row as stored, its sample interval the weight",
    point: point({ project_id: "prj_a", path: "/agents/x", weight: 4 }),
    row: {
      time: "2026-09-30T12:00:07.000Z",
      worker: "os-prd",
      project_id: "prj_a",
      path: "/agents/x",
      name: "subscription.delivery_ms",
      kind: "timing",
      labels: "row=config",
      value: 182.5,
      weight: 4,
    },
  },
  {
    name: "a point of no context has a null project and path",
    point: point({ project_id: "", path: "" }),
    row: {
      time: "2026-09-30T12:00:07.000Z",
      worker: "os-prd",
      project_id: null,
      path: null,
      name: "subscription.delivery_ms",
      kind: "timing",
      labels: "row=config",
      value: 182.5,
      weight: 1,
    },
  },
])("$name", ({ point, row }) => {
  const answer = JSON.stringify({ meta: [], data: [point], rows: 1 });
  expect(metricsRows(analyticsEngineRows(answer))).toEqual([row]);
});

test("rows are sent in JSON array chunks under 5 MB, every row once, in order", () => {
  const rows = metricsRows(
    Array.from({ length: 20_000 }, (_, index) =>
      point({ labels: `row=${"x".repeat(150)}${index}` }),
    ),
  );
  const bodies = chunks(rows);
  expect(bodies.map((body) => Buffer.byteLength(body) < 4_500_000)).toEqual([true, true]);
  expect(bodies.flatMap((body) => JSON.parse(body))).toEqual(rows);
});

/** A raw point as the copy's Analytics Engine query answers it: a UInt32 `unix` and `weight`. */
function point(fields: Record<string, unknown>) {
  return {
    unix: H0 + 7,
    name: "subscription.delivery_ms",
    kind: "timing",
    worker: "os-prd",
    project_id: "prj_a",
    path: "/",
    labels: "row=config",
    value: 182.5,
    weight: 1,
    ...fields,
  };
}
