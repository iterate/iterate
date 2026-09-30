// metrics.test.ts — the data point each call writes (docs/telemetry.md#metrics), and a point
// Analytics Engine refuses, dropped with one warning.
import { expect, test, vi } from "vitest";
import { type Metrics, type MetricsSource, metrics } from "./metrics.ts";

const context: MetricsSource = { worker: "pr3142-a1b2c3d-os", projectId: "prj_1", path: "/agents" };

test.for([
  {
    name: "a count is one unless it says otherwise",
    source: context,
    call: (m: Metrics) => m.count("subscription.retries", undefined, "row=config"),
    point: {
      indexes: ["prj_1"],
      blobs: [
        "subscription.retries",
        "count",
        "pr3142-a1b2c3d-os",
        "prj_1",
        "/agents",
        "row=config",
      ],
      doubles: [1],
    },
  },
  {
    name: "a gauge is its value",
    source: context,
    call: (m: Metrics) => m.gauge("subscription.pending", 12, "row=platform"),
    point: {
      indexes: ["prj_1"],
      blobs: [
        "subscription.pending",
        "gauge",
        "pr3142-a1b2c3d-os",
        "prj_1",
        "/agents",
        "row=platform",
      ],
      doubles: [12],
    },
  },
  {
    name: "a timing is its milliseconds, with no labels as an empty blob",
    source: context,
    call: (m: Metrics) => m.time("subscription.delivery_ms", 850),
    point: {
      indexes: ["prj_1"],
      blobs: ["subscription.delivery_ms", "timing", "pr3142-a1b2c3d-os", "prj_1", "/agents", ""],
      doubles: [850],
    },
  },
  {
    name: "a point of no context is indexed under platform, its project and path null",
    source: { worker: "os-prd" },
    call: (m: Metrics) => m.count("health.checked", 3),
    point: {
      indexes: ["platform"],
      blobs: ["health.checked", "count", "os-prd", null, null, ""],
      doubles: [3],
    },
  },
])("$name", ({ source, call, point }) => {
  const points: AnalyticsEngineDataPoint[] = [];
  call(metrics({ writeDataPoint: (written) => void points.push(written!) }, source));
  // exact: the blob layout is what every query reads, and can only grow at the end
  expect(points).toEqual([point]);
});

test("with no dataset bound, a call writes nothing and throws nothing", () => {
  expect(() => metrics(undefined, context).count("subscription.retries")).not.toThrow();
});

test("a point past the invocation's limit is dropped, and only the first drop warns", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const full = metrics(
    {
      writeDataPoint: () => {
        throw new Error("Too many data points written in this invocation");
      },
    },
    context,
  );
  full.count("subscription.retries");
  full.gauge("subscription.pending", 4);
  expect(warn.mock.calls).toMatchObject([
    [{ event: "metrics.point-dropped", name: "subscription.retries" }],
  ]);
});
