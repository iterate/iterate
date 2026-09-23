// __workers-tests__/agent-revive.test.ts — THE GUARANTEE: an agent's open LLM request survives the
// death of its context. The model call runs in the facet's BACKGROUND (rule 3, packages/iterate
// stream/processor.ts: never awaited by a batch), so no batch, cursor or push remembers it; what does
// is the CLAIM the engine holds on its context's alarm while any attempt is in flight (a kv row on
// the context, `processors.claim` — facets cannot set alarms, workerd#6810). Killed mid-call, the
// context keeps its alarm; the alarm pass spends the claim and calls the facet's `revive()`, which
// materializes it, catches up, finds the request open with nobody running it, and runs it again.
// These tests are the only ones that can kill a context on purpose (evictDurableObject) and fire
// its alarm on demand (runDurableObjectAlarm).
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { RpcTarget } from "capnweb";
import { beforeAll, expect, test, vi } from "vitest";
import type { StreamEvent } from "iterate/next/stream/processor";
import { installAgents } from "../runtime/install.ts";
import agentRuntime from "../../../configs-next/with-agents/agents.js?raw";
import {
  adminCredentials,
  applyDirectorySchema,
  openSession,
  owedAlarm,
  releasePins,
  stub,
  until,
} from "../../os/__workers-tests__/support.ts";

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
  await installAgents(itx as never, agentRuntime);
  const support = itx.cd("/agents/support");
  await support.provide("itx.ai", model);
  await itx.invoke(["itx", "agents", ["create", "/agents/support"]]);
  const agent = {
    message: (text: string) =>
      itx.invoke(["itx", "agents", ["get", "/agents/support"], ["message", text]]),
  };
  await support.append({
    type: "events.iterate.com/agent/configured",
    payload: { config: { llm: { model: "@cf/meta/llama-4-scout-17b-16e-instruct" } } },
  });
  await agent.message("What is the answer?");
  await until("the model is asked", () => model.calls === 1);
  const s = stub(AGENT);
  expect(short(await read(AGENT))).toContain("agent/llm-request-requested");
  expect(short(await read(AGENT))).not.toContain("agent/llm-request-settled");

  // (1) THE PROMISE, MADE BEFORE ANY DEATH: with an attempt in flight, the context holds the agent's
  // claim — a kv row — and the alarm derived from it. No schedule, no event: nothing in the log.
  expect(await s.invoke("itx.schedules.list()")).toEqual([]);
  expect(
    await runInDurableObject(s, (_i, state) => state.storage.kv.get("facet-claim:agent")),
  ).toBeGreaterThan(Date.now());
  expect(
    owedAlarm(await runInDurableObject(s, (_i, state) => state.storage.getAlarm())),
  ).not.toBeNull();

  // (2) THE DEATH: the release aborts the facet with its call in flight (what a crash or an eviction
  // does on the edge) and returns its borrowed model; the first answer then arrives at a facet that
  // no longer exists, which ends the call the context still had in flight, and the dormant context
  // is evicted. Nothing touches the context afterwards: a request would be a wake of its own.
  await releasePins(AGENT);
  model.answerFirst({ response: "an answer nobody is left to hear" });
  await evictDurableObject(s);
  await new Promise((r) => setTimeout(r, 300));
  expect(model.calls).toBe(1); // stalled, not settled: nobody is running the open request

  // (3) THE REVIVE: time passes the claim and the alarm fires into an evicted context. The pass
  // spends the claim and calls the facet's revive(): it materializes, catches up, finds the open
  // request with nobody running it, asks the model again — and this time the answer lands.
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
  // ONE request, run twice; the second run follows a wake BY ALARM — the only thing between the
  // request and its settle besides the wake record is the agent's own work: no tick, no schedule.
  expect(short(log).filter((t) => t === "agent/llm-request-requested")).toHaveLength(1);
  const requested = log.find((e) => e.type === "events.iterate.com/agent/llm-request-requested")!;
  const between = log.filter((e) => e.offset > requested.offset && e.offset < settled.offset);
  expect(between.map((e) => e.type)).toEqual(["events.iterate.com/stream/woken"]);
  expect(between[0]!.payload).toMatchObject({ reason: "alarm" });
  // Settled, nothing in flight: the claim is released and the context owes no alarm.
  await until(
    "no claim",
    async () =>
      (await runInDurableObject(s, (_i, state) => state.storage.kv.get("facet-claim:agent"))) ===
      undefined,
  );
  // the claim goes first and the alarm derived from it a moment later: wait for it the same way
  await until(
    "no alarm owed",
    async () =>
      owedAlarm(await runInDurableObject(s, (_i, state) => state.storage.getAlarm())) === null,
  );
});
