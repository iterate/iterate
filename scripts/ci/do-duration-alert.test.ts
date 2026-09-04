import { expect, test } from "vitest";
import { renderDailyThread } from "./do-duration-alert.ts";

const now = new Date("2026-09-04T05:41:00Z");
const runUrl = "https://github.com/iterate/iterate/actions/runs/1";
const links =
  "<https://github.com/iterate/iterate/tree/main/apps/os/tasks/do-duration-leak|incident docs> <https://github.com/iterate/iterate/actions/runs/1|workflow run> ($12.50/M GB-s, 1000 DO-hours ≈ $5.60)";

test("a chronic breach is the headline's business; only a breach in the last two hours is a reply", () => {
  const thread = renderDailyThread({
    now,
    runUrl,
    testRun: false,
    readings: [
      {
        label: "dev/preview",
        ceilingDoHours: 500,
        failure: null,
        summary: {
          // Erased slots: nothing ran overnight, and the last activity was yesterday.
          activeTime: {
            ceilingDoHours: 500,
            hours: [{ hour: "2026-09-03T23:00:00Z", doHours: 1 }],
            breachedHours: [],
          },
          pinnedInvocations: { thresholdHours: 1, rows: [] },
        },
      },
      {
        label: "prd",
        ceilingDoHours: 600,
        failure: null,
        summary: {
          activeTime: {
            ceilingDoHours: 600,
            hours: [
              { hour: "2026-09-03T23:00:00Z", doHours: 542 },
              { hour: "2026-09-04T00:00:00Z", doHours: 539 },
              { hour: "2026-09-04T01:00:00Z", doHours: 536 },
              { hour: "2026-09-04T02:00:00Z", doHours: 537 },
              { hour: "2026-09-04T03:00:00Z", doHours: 542 },
              { hour: "2026-09-04T04:00:00Z", doHours: 812 },
              { hour: "2026-09-04T05:00:00Z", doHours: 401 },
            ],
            breachedHours: [{ hour: "2026-09-04T04:00:00Z", doHours: 812 }],
          },
          pinnedInvocations: {
            thresholdHours: 1,
            rows: [
              { date: "2026-09-04", script: "os-prd", wallTimeP99Hours: 1.94, requests: 1200 },
            ],
          },
        },
      },
    ],
  });

  expect(thread.headline).toBe(
    [
      "📒 Durable Objects — 2026-09-04 (UTC) · updated 05:41",
      "dev/preview: ✅ 23:00 → 1 DO-hours (~$0.01/h) · today 0 DO-hours ≈ $0.00 · 0/0 h over 500",
      "prd: 🚨 05:00 → 401 DO-hours (~$2.26/h) · today 3,367 DO-hours ≈ $19 · 1/6 h over 600 · pinned: os-prd P99=1.94h",
      links,
    ].join("\n"),
  );
  expect(thread.replies).toEqual([
    [
      "🚨 Durable Objects hours over 600. account: prd.",
      "Latest: 04:00 → 812 DO-hours (~$4.57/h)",
      "Also pinned: os-prd  wallTimeP99=1.94h",
      links,
    ].join("\n"),
  ]);
});

test("an hour over the ceiling earlier today stays in the headline count without a fresh reply", () => {
  const thread = renderDailyThread({
    now,
    runUrl,
    testRun: false,
    readings: [
      {
        label: "dev/preview",
        ceilingDoHours: 500,
        failure: null,
        summary: {
          activeTime: {
            ceilingDoHours: 500,
            hours: [
              { hour: "2026-09-04T01:00:00Z", doHours: 2225 },
              { hour: "2026-09-04T02:00:00Z", doHours: 40 },
              { hour: "2026-09-04T04:00:00Z", doHours: 3 },
            ],
            breachedHours: [{ hour: "2026-09-04T01:00:00Z", doHours: 2225 }],
          },
          pinnedInvocations: { thresholdHours: 1, rows: [] },
        },
      },
    ],
  });

  expect(thread.replies).toEqual([]);
  expect(thread.headline).toContain(
    "dev/preview: ✅ 04:00 → 3 DO-hours (~$0.02/h) · today 2,268 DO-hours ≈ $13 · 1/3 h over 500",
  );
});

test("a probe that could not run is said so in the headline and as a reply, never as a clean account", () => {
  const thread = renderDailyThread({
    now,
    runUrl: null,
    testRun: true,
    readings: [
      {
        label: "dev/preview",
        ceilingDoHours: 1,
        failure: "Cloudflare GraphQL errors: authentication error",
        summary: null,
      },
    ],
  });

  expect(thread.headline).toBe(
    [
      "🧪 TEST RUN — 📒 Durable Objects — 2026-09-04 (UTC) · updated 05:41",
      "dev/preview: ⚠️ probe failed this run — Cloudflare GraphQL errors: authentication error",
      "<https://github.com/iterate/iterate/tree/main/apps/os/tasks/do-duration-leak|incident docs> ($12.50/M GB-s, 1000 DO-hours ≈ $5.60)",
    ].join("\n"),
  );
  expect(thread.replies).toHaveLength(1);
  expect(thread.replies[0]).toContain("⚠️ DO duration probe FAILED to run. account: dev/preview.");
});
