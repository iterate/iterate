// e2e/alarm-held-probe.e2e.test.ts — OPT-IN PROBE of the platform defect src/alarm-coordinator.ts
// works around (the overdue watch): Cloudflare sometimes holds an armed Durable Object alarm 20–60 s
// past its time while `storage.getAlarm()` reports it. Measured through the product with nothing
// else in play — no facet, no processor: each of N fresh contexts arms a schedule 60 s out, then
// moves the alarm to 1.5 s out (the move held most often), and waits for it. Normal delivery is late
// by milliseconds (p99 4 ms); a held alarm lands ~5 s late with the watch (its re-arm) and 20–60 s
// without it. RED while the defect exists, printing each held alarm; GREEN on repeated deployed runs
// is the evidence to delete the watch.
//
//   RUN_ALARM_HELD_PROBE=1 WORKER_BASE_URL=<a preview> doppler run --project os --config preview -- \
//     pnpm exec vitest run --configLoader runner --project e2e alarm-held-probe

import { expect, test } from "vitest";
import { freshCtx, openItx } from "./support/client.ts";
import { projectHostsAreLocal } from "./support/project-host.ts";

const probe = test.skipIf(projectHostsAreLocal() || process.env.RUN_ALARM_HELD_PROBE !== "1");

probe(
  "a Durable Object alarm moved earlier is delivered at its time",
  { timeout: 120_000 },
  async () => {
    const contexts = Number(process.env.ALARM_HELD_PROBE_CONTEXTS || 200);
    const outcomes = await Promise.all(
      Array.from({ length: contexts }, async () => {
        const ctx = freshCtx("alarm_held_probe");
        const itx = openItx(ctx);
        await itx.schedules.set({
          key: "later",
          when: { afterMs: 60_000 },
          events: [{ type: "later/due" }],
        });
        const soon = await itx.schedules.set({
          key: "soon",
          when: { afterMs: 1_500 },
          events: [{ type: "soon/due" }],
        });
        const due = await itx.waitForEvent({
          type: "soon/due",
          afterOffset: soon.scheduledAtOffset,
          timeoutMs: 90_000,
        });
        const row = await itx.readEvents(soon.scheduledAtOffset - 1, 1);
        const lateMs = Date.parse(due.createdAt) - (Date.parse(row.events[0].createdAt) + 1_500);
        return { ctx, lateMs };
      }),
    );
    const held = outcomes.filter((outcome) => outcome.lateMs > 3_000);
    console.log(
      `${held.length} of ${contexts} alarms held past 3 s:\n` +
        held.map((outcome) => `  ${outcome.ctx}: ${outcome.lateMs} ms late`).join("\n"),
    );
    expect(held).toEqual([]);
  },
);
