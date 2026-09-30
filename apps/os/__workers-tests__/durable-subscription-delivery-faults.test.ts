import { runDurableObjectAlarm } from "cloudflare:test";
import { expect, test, vi } from "vitest";
import { flakyCounter } from "./sources.ts";
import { readLog, releasePins, stub, until } from "./support.ts";

test("a default-consuming permanent failure does not redeliver its own failed receipt", async () => {
  const context = "prj_durable_failure_receipt";
  const s = stub(context);
  await s.append({
    type: "events.iterate.com/itx/subscription-configured",
    payload: {
      name: "refuses",
      target: [
        "itx",
        "facets",
        ["get", "refusal", flakyCounter("permanent refusal", { code: "PERMANENT_FAILURE" })],
        "processEventBatch",
      ],
      delivery: "durable",
      ordered: false,
    },
  });
  await s.append({ type: "work" });
  await until("the first terminal receipt lands", async () => {
    const failures = (await readLog(context)).filter(
      (event) => event.type === "events.iterate.com/itx/subscription-delivery-failed",
    );
    return failures.length === 1 ? failures : undefined;
  });
  vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] });
  try {
    vi.setSystemTime(Date.now() + 30_000);
    await runDurableObjectAlarm(s);
  } finally {
    vi.useRealTimers();
  }
  expect(
    (await readLog(context)).filter(
      (event) => event.type === "events.iterate.com/itx/subscription-delivery-failed",
    ),
  ).toHaveLength(1);
  await releasePins(context);
});
