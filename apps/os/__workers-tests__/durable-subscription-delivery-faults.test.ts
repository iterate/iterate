import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { expect, test, vi } from "vitest";
import { flakyCounter } from "./sources.ts";
import { readLog, releasePins, rowOf, stub, until } from "./support.ts";

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
  await until("the failed receipt is scanned without a target call", async () => {
    const current = await runInDurableObject(s, (instance) =>
      instance.subscriptionDeliveryStatus(),
    );
    const fanOut = Object.values(current.snapshots)[0]?.fanOut;
    const failures = (await readLog(context)).filter(
      (event) => event.type === "events.iterate.com/itx/subscription-delivery-failed",
    );
    return (
      fanOut &&
      failures[0] &&
      fanOut.admittedThrough >= failures[0].offset &&
      fanOut.pending.length === 0
    );
  });
  expect(await s.invoke(["itx", "facets", ["get", "refusal"], ["tries"]])).toHaveLength(1);
  await releasePins(context);
});

test("a retry whose range ends at an ephemeral offset survives a later body-budget page gap", async () => {
  const context = "prj_durable_bounded_retry";
  const s = stub(context);
  await s.append({
    type: "events.iterate.com/itx/subscription-configured",
    payload: {
      name: "bounded",
      target: [
        "itx",
        "facets",
        ["get", "flaky", flakyCounter("first delivery fails")],
        "processEventBatch",
      ],
      delivery: "durable",
      consumes: ["work"],
    },
  });
  const [first] = (await s.append(
    { type: "work", payload: { body: "a".repeat(3 * 1024 * 1024) } },
    { type: "ignored", ephemeral: true },
  )) as { offset: number }[];
  await until("the first range has a persisted retry", async () => {
    const status = await runInDurableObject(s, (instance) => instance.subscriptionDeliveryStatus());
    const pending = Object.values(status.snapshots)[0]?.pending;
    return pending?.error === "first delivery fails" && pending.nextAttemptAtMs
      ? status
      : undefined;
  });
  const [later] = (await s.append({
    type: "work",
    payload: { body: "b".repeat(6 * 1024 * 1024) },
  })) as { offset: number }[];
  vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] });
  try {
    vi.setSystemTime(Date.now() + 30_000);
    await runDurableObjectAlarm(s);
  } finally {
    vi.useRealTimers();
  }
  const row = await until("bounded retry and later work both confirm", async () => {
    const current = await rowOf(context, "bounded");
    return current?.cursor?.confirmedOffset !== undefined &&
      current.cursor.confirmedOffset >= later.offset &&
      !current.halted
      ? current
      : undefined;
  });
  expect(row.cursor?.confirmedOffset).toBeGreaterThanOrEqual(first.offset);
  expect(row.halted).toBeUndefined();
  await releasePins(context);
});

test("a fan-out selective resume of an ephemeral gap records one failure without halting", async () => {
  const context = "prj_durable_invalid_selective_resume";
  const s = stub(context);
  await s.append({
    type: "events.iterate.com/itx/subscription-configured",
    payload: {
      name: "selective",
      target: [
        "itx",
        "facets",
        ["get", "unused", flakyCounter("must not receive an unconsumed event")],
        "processEventBatch",
      ],
      delivery: "durable",
      ordered: false,
      consumes: ["wanted"],
    },
  });
  const [unconsumed, gap, tail] = (await s.append(
    { type: "ignored" },
    { type: "ephemeral-gap", ephemeral: true },
    { type: "ignored-tail" },
  )) as { offset: number }[];
  await s.append({
    type: "events.iterate.com/itx/subscription-delivery-resumed",
    payload: { name: "selective", afterOffset: tail.offset },
  });
  await until("fan-out admits the unconsumed range", async () => {
    const status = await runInDurableObject(s, (instance) => instance.subscriptionDeliveryStatus());
    const fanOut = Object.values(status.snapshots)[0]?.fanOut;
    return fanOut && fanOut.admittedThrough >= tail.offset && fanOut.pending.length === 0
      ? fanOut
      : undefined;
  });

  await s.append({
    type: "events.iterate.com/itx/subscription-delivery-resumed",
    payload: { name: "selective", offset: gap.offset },
  });
  const failure = await until("invalid selective resume is terminally acknowledged", async () => {
    const failures = (await readLog(context)).filter(
      (event) =>
        event.type === "events.iterate.com/itx/subscription-delivery-failed" &&
        (event.payload as { name?: string; offset?: number }).name === "selective",
    );
    const status = await runInDurableObject(s, (instance) => instance.subscriptionDeliveryStatus());
    const fanOut = Object.values(status.snapshots)[0]?.fanOut;
    return failures.length === 1 && fanOut && fanOut.pending.length === 0 ? failures[0] : undefined;
  });
  expect(failure).toMatchObject({ payload: { offset: gap.offset } });
  const ignored = (await readLog(context)).find((event) => event.offset === unconsumed.offset);
  expect(failure.source?.cause).not.toEqual(ignored?.source?.cause);
  expect((await rowOf(context, "selective"))?.halted).toBeUndefined();
  expect(unconsumed.offset).toBeLessThan(gap.offset);
  await releasePins(context);
});
