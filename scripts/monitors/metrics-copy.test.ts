// The metrics copy's decisions: which hours a run copies after its watermark, a data point as a
// `metrics` row, the chunks it sends, and when the watermark moves. The reads and sends themselves
// are proven against the dev account.
import { expect, test } from "vitest";
import { telemetryEnvs } from "../../envs.ts";
import {
  chunks,
  COPY_HOURS,
  copyMetrics,
  hoursToCopy,
  metricsRows,
  type MetricsRow,
} from "./metrics-copy.ts";

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

// A run at H0 + 3 h 41 min with its watermark at H0: the two closed hours after it are owed.
test.for<{
  name: string;
  /** What Analytics Engine holds of each owed hour, and what its `count()` says if not as many. */
  hours: { points: ReturnType<typeof point>[]; counted?: number }[];
  /** No watermark to keep: any run but a real one on main. */
  dry?: boolean;
  /** The send, by its place among them, that the stream refuses. */
  refusedSend?: number;
  sent: number[];
  kept: number[];
  throws?: RegExp;
}>([
  {
    name: "each closed hour after the watermark is sent whole, and its watermark kept as it is",
    hours: [{ points: [point({}), point({})] }, { points: [point({})] }],
    sent: [2, 1],
    kept: [H0 + HOUR, H0 + 2 * HOUR],
  },
  {
    name: "with no watermark to keep, nothing is sent",
    hours: [{ points: [point({})] }, { points: [point({})] }],
    dry: true,
    sent: [],
    kept: [],
  },
  {
    name: "one point that is no point is skipped, and the rest of its hour sent",
    hours: [{ points: [point({}), point({ value: null })] }, { points: [] }],
    sent: [1],
    kept: [H0 + HOUR, H0 + 2 * HOUR],
  },
  {
    name: "an hour none of whose points is a point is not passed over",
    hours: [{ points: [point({ value: null })] }, { points: [point({})] }],
    sent: [],
    kept: [],
    throws: /none of Analytics Engine's 1 points is a point/,
  },
  {
    name: "an answer short of its hour's count is not sent",
    hours: [{ points: [point({})], counted: 2 }, { points: [point({})] }],
    sent: [],
    kept: [],
    throws: /answered 1 of 2 points/,
  },
  {
    name: "a send the stream refuses keeps the hours before it, and not its own",
    hours: [{ points: [point({})] }, { points: [point({})] }],
    refusedSend: 1,
    sent: [1],
    kept: [H0 + HOUR],
    throws: /the stream refused/,
  },
])("copyMetrics: $name", async ({ hours, dry, refusedSend, sent, kept, throws }) => {
  const copied = { sent: [] as number[], kept: [] as number[] };
  let sends = 0;
  const run = copyMetrics({
    lake: "preview",
    env: telemetryEnvs.preview,
    copiedThrough: H0,
    now: new Date((H0 + 3 * HOUR + 41 * 60) * 1_000),
    keepWatermark: dry ? undefined : (hour) => void copied.kept.push(hour),
    api: {
      sql: async (sql) => {
        const from = Number(/toDateTime\((\d+)\)/.exec(sql)![1]);
        const hour = hours[(from - H0) / HOUR - 1]!;
        return sql.startsWith("SELECT count()")
          ? [{ points: hour.counted ?? hour.points.length }]
          : hour.points;
      },
      send: async (body) => {
        if (sends++ === refusedSend) throw new Error("the stream refused");
        copied.sent.push(JSON.parse(body).length);
      },
    },
  });
  if (throws) await expect(run).rejects.toThrow(throws);
  else await run;
  expect(copied).toEqual({ sent, kept });
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
