// __workers-tests__/agent-revive.test.ts — THE GUARANTEE: an agent's open LLM request survives the
// death of its context. The model call runs in the facet's BACKGROUND (rule 3, packages/iterate
// stream/processor.ts: never awaited by a batch), so no batch, cursor or push remembers it; what does
// is the one-shot REVIVE the engine arms on the context BEFORE any background attempt starts — a
// scheduled append, the one timer a facet has (workerd#6810: facets cannot set alarms). Killed
// mid-call, the context keeps its alarm; the alarm's tick is a durable commit; the commit is pushed
// to the agent row; the push materializes the facet, which catches up, finds the request open with
// nobody running it, and runs it again. This lane is the only one that can kill a context on purpose
// (evictDurableObject) and fire its alarm on demand (runDurableObjectAlarm).
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { RpcTarget } from "capnweb";
import { beforeAll, expect, test, vi } from "vitest";
import type { StreamEvent } from "iterate/next/stream/processor";
import {
  adminCredentials,
  applyDirectorySchema,
  openSession,
  quiesce,
  stub,
  until,
} from "./support.ts";

beforeAll(applyDirectorySchema);

/** A model whose FIRST answer waits until the test releases it (the context dies mid-call, so it
 *  arrives with nobody left to hear it) and whose second is the answer. */
class ParkingModel extends RpcTarget {
  calls = 0;
  answerFirst!: (answer: { response: string }) => void;
  readonly #first = new Promise<{ response: string }>((resolve) => (this.answerFirst = resolve));
  run(_model: string, _inputs: unknown): Promise<{ response: string }> | { response: string } {
    this.calls += 1;
    return this.calls === 1 ? this.#first : { response: "42" };
  }
}

const PROJECT = "prj_agent_revive";
/** The agent's own context — the facet is hosted there, and so is everything it schedules. */
const AGENT = `${PROJECT}.iterate/agents/support`;
const read = async (ctx: string) =>
  ((await stub(ctx).invoke(["itx", ["readEvents", 0, 500]])) as { events: StreamEvent[] }).events;
const short = (log: StreamEvent[]) =>
  log
    .filter((e) => /agent\/|woken|revived/.test(e.type))
    .map((e) => e.type.replace("events.iterate.com/", ""));

test("KILLED MID-CALL, THE REQUEST CONTINUES: the context dies with the model call in flight; its alarm revives the agent, which runs the open request again and settles it", async () => {
  const model = new ParkingModel();
  const itx = await (await openSession()).authenticate(adminCredentials()).projects.get(PROJECT);
  const support = itx.cd("/agents/support");
  await support.provide("itx.ai", model);
  const agent = itx.agents.get("/agents/support");
  await agent.create({ systemPrompt: "Be terse." });
  await support.append({
    type: "events.iterate.com/agent/configured",
    payload: { config: { llm: { model: "@cf/meta/llama-4-scout-17b-16e-instruct" } } },
  });
  await agent.message("What is the answer?");
  await until("the model is asked", () => model.calls === 1);
  const s = stub(AGENT);
  expect(short(await read(AGENT))).toContain("agent/llm-request-requested");
  expect(short(await read(AGENT))).not.toContain("agent/llm-request-settled");

  // (1) THE PROMISE, MADE BEFORE ANY DEATH: with an attempt in flight, the context holds a durable
  // wake — the engine's revive schedule, and the alarm the context derives from it.
  const schedules = (await s.invoke("itx.schedules.list()")) as { key: string }[];
  expect(schedules.map((row) => row.key)).toEqual([JSON.stringify(["revive", "agent"])]);
  expect(await runInDurableObject(s, (_i, state) => state.storage.getAlarm())).not.toBeNull();

  // (2) THE DEATH: the release aborts the facet with its call in flight (what a crash or an eviction
  // does on the edge) and returns its borrowed model; the first answer then arrives at a facet that
  // no longer exists, which ends the call the context still had in flight, and the dormant context
  // is evicted. Nothing touches the context afterwards: a request would be a wake of its own.
  await quiesce(AGENT);
  model.answerFirst({ response: "an answer nobody is left to hear" });
  await evictDurableObject(s);
  await new Promise((r) => setTimeout(r, 300));
  expect(model.calls).toBe(1); // stalled, not settled: nobody is running the open request

  // (3) THE REVIVE: time passes the revive delay and the alarm fires into an evicted context. The
  // fresh incarnation's wake and the tick are pushed to the agent row; the facet materializes, finds
  // the open request, asks the model again — and this time the answer lands.
  vi.useFakeTimers({ now: Date.now() + 21_000, toFake: ["Date"], shouldAdvanceTime: true });
  try {
    expect(await runDurableObjectAlarm(s)).toBe(true); // an alarm WAS in storage: the revive's
    await until("the model is asked again", () => model.calls === 2);
    await until("settled", async () =>
      short(await read(AGENT)).includes("agent/llm-request-settled"),
    );
  } finally {
    vi.useRealTimers();
  }
  const log = await read(AGENT);
  const settled = log.find((e) => e.type === "events.iterate.com/agent/llm-request-settled")!;
  expect(settled.payload).toMatchObject({ result: { status: "succeeded", text: "42" } });
  // ONE request, run twice; the second run follows a wake BY ALARM and the revive tick.
  expect(short(log).filter((t) => t === "agent/llm-request-requested")).toHaveLength(1);
  const requested = log.find((e) => e.type === "events.iterate.com/agent/llm-request-requested")!;
  const between = log.filter((e) => e.offset > requested.offset && e.offset < settled.offset);
  expect(between.map((e) => e.type)).toContain("events.iterate.com/stream/woken");
  expect(between.at(-1)?.type).not.toBe("events.iterate.com/agent/llm-request-requested");
  expect(
    between.filter((e) => e.type === "events.iterate.com/stream/woken").at(-1)?.payload,
  ).toMatchObject({ reason: "alarm" });
  expect(between.map((e) => e.type)).toContain("events.iterate.com/processor/revived");
  // Settled, nothing in flight: the revive is retracted and the context owes no alarm for it.
  await until(
    "no schedule",
    async () => ((await s.invoke("itx.schedules.list()")) as unknown[]).length === 0,
  );
});
