// __workers-tests__/context-runs.test.ts — THE CONTEXT'S SCRIPT RUNS, pinned at the DO: `itx.run(script)`
// is a `context/run-requested` on the log (attributed to the caller; the event's offset IS the run),
// the context's own runner (iterate-context-durable-object.ts `#startRequestedRuns` / `#executeRun`)
// at that commit, and a `run-settled` naming that offset, which the caller's wait resolves on. A
// LITERAL request appended by anyone runs the same way. A run the context's restart interrupted is
// settled `interrupted` by the wake record — never re-run — which only the workers project can
// prove (the context is aborted mid-run).
import { runInDurableObject } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import type { StreamEvent } from "iterate/next/stream/processor";
import { adminCredentials, applyDirectorySchema, openSession, stub, until } from "./support.ts";

beforeAll(applyDirectorySchema);

const PROJECT = "prj_context_runs";
const ROOT = `${PROJECT}.iterate/`;

const read = async (ctx: string): Promise<StreamEvent[]> =>
  ((await stub(ctx).invoke(["itx", ["readEvents", 0, 500]])) as { events: StreamEvent[] }).events;
const runEvents = async (ctx: string) =>
  (await read(ctx)).filter((e) => e.type.startsWith("events.iterate.com/context/run-"));
const openScriptRuns = async (ctx: string) =>
  (
    (await stub(ctx).invoke("itx.facets.get('core').snapshot()")) as {
      state: { scriptRuns: Record<string, unknown> };
    }
  ).state.scriptRuns;

test("itx.run: the request lands first, stamped with the caller; the runner settles it naming the request's offset; the caller gets the result — one pair of events per run, on the context it ran against", async () => {
  const itx = await (await openSession()).authenticate(adminCredentials()).projects.get(PROJECT);
  expect(await itx.run("async (itx) => { await itx.kv.put('n', '7'); return { n: 7 } }")).toEqual({
    n: 7,
  });
  const pair = await runEvents(ROOT);
  expect(pair.map((e) => e.type.replace("events.iterate.com/", ""))).toEqual([
    "context/run-requested",
    "context/run-settled",
  ]);
  const [requested, settled] = pair as [StreamEvent, StreamEvent];
  expect(requested.source?.principal).toEqual({ actor: "admin" }); // who asked
  expect(settled.source?.principal).toBeUndefined(); // the context's own record
  expect(settled.payload).toEqual({
    requestOffset: requested.offset,
    settlement: { status: "succeeded", result: { n: 7 } },
  });
  expect(await itx.kv.get("n")).toBe("7"); // it ran against this context
  // a throwing script: the rejection IS the settlement's error, and the log says so
  await expect(itx.run("async () => { throw new Error('nope') }")).rejects.toThrow("nope");
  expect((await runEvents(ROOT)).at(-1)!.payload).toMatchObject({
    settlement: { status: "failed", error: "nope", failureKind: "runtime" },
  });
  // a value JSON cannot carry: the round trip drops it (no result), never a phantom
  expect(await itx.run("async () => undefined")).toBeUndefined();
  expect((await runEvents(ROOT)).at(-1)!.payload).toEqual({
    requestOffset: expect.any(Number),
    settlement: { status: "succeeded" },
  });
  expect(await openScriptRuns(ROOT)).toEqual({});
});

test("a LITERAL run-requested appended by a Workers-RPC caller runs exactly as itx.run does: the runner starts at the commit and settles it naming that offset; two requests are two rows, each settled on its own", async () => {
  const before = (await runEvents(ROOT)).length;
  const [first] = (await stub(ROOT).append({
    type: "events.iterate.com/context/run-requested",
    payload: { code: "async (itx) => (await itx.whoami()).path" },
  })) as [StreamEvent];
  const [second] = (await stub(ROOT).append({
    type: "events.iterate.com/context/run-requested",
    payload: { code: "async () => 2" },
  })) as [StreamEvent];
  const settledFor = async (requestOffset: number) =>
    (await runEvents(ROOT))
      .slice(before)
      .find(
        (e) =>
          e.type === "events.iterate.com/context/run-settled" &&
          (e.payload as { requestOffset: number }).requestOffset === requestOffset,
      );
  expect((await until("the first is settled", () => settledFor(first.offset))).payload).toEqual({
    requestOffset: first.offset,
    settlement: { status: "succeeded", result: "/" },
  });
  expect((await until("the second is settled", () => settledFor(second.offset))).payload).toEqual({
    requestOffset: second.offset,
    settlement: { status: "succeeded", result: 2 },
  });
  expect(await openScriptRuns(ROOT)).toEqual({});
});

test("KILLED MID-RUN, NEVER RE-RUN: the context dies with a script in flight; the next incarnation's wake record settles it `interrupted` — one request, one settlement, the script's side effect never repeats", async () => {
  const itx = await (await openSession()).authenticate(adminCredentials()).projects.get(PROJECT);
  const before = (await runEvents(ROOT)).length;
  // a script that parks: it counts its start, then waits far longer than this test. Requested as a
  // LITERAL append (the request returns at its commit) so no caller's call holds the context;
  // through `itx.run` the same death ends the caller's wait with a transport error and the log
  // reads the same.
  const [parked] = (await stub(ROOT).append({
    type: "events.iterate.com/context/run-requested",
    payload: {
      code: "async (itx) => { const n = Number(await itx.kv.get('starts')) || 0; await itx.kv.put('starts', String(n + 1)); await new Promise((r) => setTimeout(r, 60_000)); return 'never' }",
    },
  })) as [StreamEvent];
  await until("the script started", async () => (await itx.kv.get("starts")) === "1");
  expect(Object.keys(await openScriptRuns(ROOT))).toEqual([String(parked.offset)]);
  // THE DEATH: a crash mid-run. (An eviction cannot be forced here — the running script's isolate
  // holds `env.ITX`, a live reference to this context — so the context is aborted from inside,
  // which is what a crash or a code-update reset does; the next request boots a new incarnation.)
  await runInDurableObject(stub(ROOT), (_instance, state) => {
    state.abort("killed mid-run by the test");
  }).catch(() => {}); // abort() throws by design: nothing after it runs
  // the next request (a read) wakes a new incarnation: its wake record closes the run
  const after = (await runEvents(ROOT)).slice(before);
  expect(after.map((e) => e.type.replace("events.iterate.com/", ""))).toEqual([
    "context/run-requested",
    "context/run-settled",
  ]);
  expect(after[1]!.payload).toMatchObject({
    requestOffset: parked.offset,
    settlement: { status: "failed", failureKind: "interrupted" },
  });
  // the SAME batch as the wake record: right behind it
  const log = await read(ROOT);
  expect(log.find((e) => e.offset === after[1]!.offset - 1)!.type).toBe(
    "events.iterate.com/stream/woken",
  );
  await new Promise((r) => setTimeout(r, 500));
  expect(await itx.kv.get("starts")).toBe("1"); // not run again
  expect(await openScriptRuns(ROOT)).toEqual({});
});

test("a script's hop to a sibling context carries the platform origin: `itx.cd(path).url()` composes it there, though the sibling was never reached from the edge", async () => {
  // a project the directory knows (its slug names its URL), reached from this stamped session
  const itx = await (
    await openSession()
  )
    .authenticate(adminCredentials())
    .projects.create({ project: `runs-url-${Date.now().toString(36)}` });
  // the run's own caller carries no origin (loaded code speaks for the project); the context fills
  // in the one the edge stamped when this session reached it, and the hop to `/child` hands it on
  const urls = (await itx.run(
    "async (itx) => ({ here: await itx.url(), sibling: await itx.cd('/child').url({ app: 'site' }) })",
  )) as { here: string; sibling: string };
  expect(urls.here).toMatch(/^https:\/\/[a-z0-9-]+\.projects\.test\/$/);
  expect(urls.sibling).toMatch(/^https:\/\/site--[a-z0-9-]+\.projects\.test\/$/);
});
