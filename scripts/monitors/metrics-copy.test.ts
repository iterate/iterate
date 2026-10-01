// The metrics copy's decisions: which hours a run copies after its watermark, a data point as a
// `metrics` row, and the chunks it sends. The reads and sends themselves are proven against the dev
// account.
import { expect, test } from "vitest";
import { chunks, COPY_HOURS, hoursToCopy, metricsRows, type MetricsRow } from "./metrics-copy.ts";

const HOUR = 3_600;
const H0 = 1_790_769_600; // 2026-09-30T12:00:00Z

test.for<{ name: string; copiedThrough: number | undefined; now: number; hours: number[] }>([
  {
    name: "a first run copies the hour that just closed",
    copiedThrough: undefined,
    now: H0 + HOUR + 41 * 60,
    hours: [H0],
  },
  {
    name: "the closed hours after the watermark, oldest first; the current hour is not closed",
    copiedThrough: H0,
    now: H0 + 3 * HOUR + 41 * 60,
    hours: [H0 + HOUR, H0 + 2 * HOUR],
  },
  {
    name: "a watermark at the last closed hour copies nothing",
    copiedThrough: H0,
    now: H0 + HOUR + 41 * 60,
    hours: [],
  },
  {
    name: "a backlog longer than a run's cap copies its oldest hours first",
    copiedThrough: H0,
    now: H0 + (COPY_HOURS + 7) * HOUR,
    hours: Array.from({ length: COPY_HOURS }, (_, index) => H0 + (index + 1) * HOUR),
  },
])("$name", ({ copiedThrough, now, hours }) => {
  expect(hoursToCopy(copiedThrough, new Date(now * 1_000))).toEqual(hours);
});

test.for<{ name: string; point: ReturnType<typeof point>; rows: MetricsRow[] }>([
  {
    name: "a point is a row as stored, its sample interval the weight",
    point: point({ project_id: "prj_a", path: "/agents/x", weight: 4 }),
    rows: [
      {
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
    ],
  },
  {
    name: "a point of no context has a null project and path",
    point: point({ project_id: "", path: "" }),
    rows: [
      {
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
    ],
  },
  {
    name: "a NaN value, which the SQL API answers as null, makes no row and holds nothing back",
    point: point({ value: null }),
    rows: [],
  },
])("$name", ({ point, rows }) => {
  // exact: the row's every column, and no row more
  expect(metricsRows([point])).toEqual(rows);
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
function point(fields: Record<string, string | number | null>) {
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
