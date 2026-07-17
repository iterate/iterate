// The pre-execution typecheck gate: a `problems` verdict settles the request
// as an error completion WITHOUT running it (and without a started event —
// the gate has no side effects, so a rejected script provably never ran);
// every other outcome — clean, unchecked, a throwing checker, no checker
// wired at all — lets the script run. The verdict policy itself (what counts
// as a provable problem) lives in checkItxScriptForExecution and is tested
// against the real compiler in domains/typecheck/virtual-project.test.ts;
// here the checker is a stub and the subject is the gate's plumbing.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../../itx-api.generated.ts";
import { recordedSpans, resetRecordedSpans } from "../../test/cloudflare-workers-shim.ts";
import type { CapabilityDescription } from "../itx/describe.ts";
import type { ScriptExecutionCheck } from "../typecheck/virtual-project.ts";
import { StreamProcessorRunner } from "../streams/stream-processor-runner.ts";
import { MemoryStream } from "../streams/test-helpers.ts";
import type { CapabilityHostProcessorContract } from "./capability-host-processor-contract.ts";
import {
  CapabilityHostProcessor,
  type CapabilityHostAncestor,
  type CapabilityHostProcessorReads,
} from "./capability-host-processor-implementation.ts";
import type { ScriptExecutionHandoff, ScriptExecutionIntent } from "./script-execution-driver.ts";
import { scriptSettlementFromEvent } from "./script-execution-settlement.ts";

const T = {
  created: "events.iterate.com/capability-host/created",
  provided: "events.iterate.com/capability-host/capability-provided",
  requested: "events.iterate.com/capability-host/script-run-requested",
  started: "events.iterate.com/capability-host/script-run-started",
  completed: "events.iterate.com/capability-host/script-run-settled",
} as const;

function capabilityHostStream(ancestorPath: string | null = null): MemoryStream {
  const stream = new MemoryStream();
  stream.events.push({
    type: T.created,
    idempotencyKey: `capability-host/created:test:${stream.path}`,
    payload: { config: { ancestorPath } },
    createdAt: new Date().toISOString(),
    offset: 1,
    path: stream.path,
  });
  return stream;
}

type Harness = {
  execute(request: ScriptExecutionHandoff): Promise<void>;
  processor: CapabilityHostProcessor;
  runner: StreamProcessorRunner<CapabilityHostProcessorContract>;
};

let nextExecution = 0;
function executionIntent(code: string): ScriptExecutionIntent {
  nextExecution += 1;
  return {
    code,
    executionId: `typecheck-test:${nextExecution}`,
    expiresAt: Date.now() + 60_000,
  };
}

/** REAL runner drive (the production registry's driver): the processor
 * journals/prepares, the simulated explicit caller executes, and fold reads
 * ride committed runner progress exactly as the hosting DO wires them. */
function makeProcessor(options: {
  stream: MemoryStream;
  run?: (code: string) => Promise<unknown>;
  ancestor?: CapabilityHostAncestor;
  path?: string;
  setScriptDeadline?: (executionId: string, expiresAt: number | null) => Promise<void>;
  typecheckScript?: (input: {
    capabilities: CapabilityDescription[];
    code: string;
  }) => Promise<ScriptExecutionCheck>;
  waitUntilEvent?: (
    input: Parameters<CapabilityHostProcessorReads["waitUntilEvent"]>[0],
    fallback: () => Promise<void>,
  ) => Promise<void>;
}): Harness {
  let runner!: Harness["runner"];
  let processor!: CapabilityHostProcessor;
  processor = new CapabilityHostProcessor({
    stream: options.stream,
    itx: {} as Project,
    path: options.path ?? "/",
    projectId: null,
    setScriptDeadline: options.setScriptDeadline ?? (async () => undefined),
    resolveAncestor: options.ancestor === undefined ? undefined : () => options.ancestor!,
    typecheckScript: options.typecheckScript,
    reads: {
      snapshot: () => runner.snapshot(),
      waitUntilEvent: (input) => {
        const fallback = () => runner.waitUntilEvent(input);
        return options.waitUntilEvent?.(input, fallback) ?? fallback();
      },
    },
  });
  runner = new StreamProcessorRunner({ processor, stream: options.stream });
  return {
    processor,
    runner,
    async execute(request) {
      if (request.preparation.status !== "ready") return;
      let settlement;
      try {
        const result = await (
          options.run ??
          (() => {
            throw new Error("must not run in this scenario");
          })
        )(request.preparation.code);
        settlement = {
          status: "succeeded" as const,
          ...(result === undefined ? {} : { result: result as never }),
        };
      } catch (error) {
        settlement = {
          status: "failed" as const,
          error: error instanceof Error ? error.message : String(error),
          failureKind: "runtime" as const,
          phase: "execution" as const,
          executionMayHaveOccurred: true,
          cancellation: "external-work-may-continue" as const,
        };
      }
      await runner.catchUp();
      await processor.settleScriptExecution(request.executionId, settlement);
    },
  };
}

async function requestScript(stream: MemoryStream, harness: Harness) {
  if (!stream.events.some((event) => event.type === T.created)) {
    await stream.append({
      type: T.created,
      payload: { config: { ancestorPath: null } },
    });
  }
  await harness.runner.catchUp();
  const request = await harness.processor.requestScript(
    executionIntent("async (itx) => itx.streams.gett('/')"),
  );
  await harness.execute(request);
  return request;
}

function completion(stream: MemoryStream) {
  return stream.events.find((event) => event.type === T.completed);
}

async function runScript(stream: MemoryStream, harness: Harness, code: string) {
  await harness.runner.catchUp();
  const request = await harness.processor.requestScript(executionIntent(code));
  await harness.execute(request);
  return await scriptResult(stream, request);
}

async function scriptResult(stream: MemoryStream, request: ScriptExecutionHandoff) {
  let completed = stream.events.find(
    (event) =>
      event.type === T.completed &&
      event.payload !== null &&
      typeof event.payload === "object" &&
      !Array.isArray(event.payload) &&
      event.payload.executionId === request.executionId,
  );
  await vi.waitFor(() => {
    completed = stream.events.find(
      (event) =>
        event.type === T.completed &&
        event.payload !== null &&
        typeof event.payload === "object" &&
        !Array.isArray(event.payload) &&
        event.payload.executionId === request.executionId,
    );
    expect(completed).toBeDefined();
  });
  expect(completed?.idempotencyKey).toBe(request.completionIdempotencyKey);
  const settlement = scriptSettlementFromEvent(completed!, request.executionId);
  if (settlement === undefined) throw new Error("completion carried no valid settlement");
  if (settlement.status === "failed") throw new Error(settlement.error);
  return {
    completedEvent: completed!,
    executionId: request.executionId,
    result: settlement.result ?? null,
  };
}

beforeEach(() => resetRecordedSpans());

describe("script execution typecheck gate", () => {
  it("settles a directly journaled request on an uncreated host without running it", async () => {
    const stream = new MemoryStream();
    const run = vi.fn(async () => null);
    const harness = makeProcessor({ stream, run });
    await stream.append({
      type: T.requested,
      payload: {
        code: "async () => null",
        executionId: "exec-unconfigured",
        expiresAt: Date.now() + 60_000,
      },
    });

    await harness.runner.catchUp();

    await vi.waitFor(() =>
      expect(completion(stream)?.payload).toMatchObject({
        executionId: "exec-unconfigured",
        settlement: { error: expect.stringContaining("has not been created") },
      }),
    );
    expect(stream.events.some((event) => event.type === T.started)).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("a problems verdict settles as an error completion — never started, never run", async () => {
    const stream = capabilityHostStream();
    const harness = makeProcessor({
      stream,
      typecheckScript: async () => ({
        verdict: "problems",
        problems: ["script:1:32 — Property 'gett' does not exist. Did you mean 'get'? (TS2551)"],
      }),
    });
    await requestScript(stream, harness);

    await vi.waitFor(() => {
      const completed = completion(stream);
      expect(completed?.payload).toMatchObject({
        executionId: expect.any(String),
        settlement: {
          status: "failed",
          error: expect.stringContaining("NOT executed"),
          failureKind: "typecheck",
          phase: "typecheck",
          executionMayHaveOccurred: false,
          cancellation: "not-applicable",
        },
      });
      expect((completed!.payload as { settlement: { error: string } }).settlement.error).toContain(
        "Did you mean 'get'",
      );
      // Shared with the run/settle lanes, so a race collapses to one completion.
      expect(completed?.idempotencyKey).toBe(
        `capability-host/script-run-settled@${(completed!.payload as { executionId: string }).executionId}`,
      );
    });
    expect(stream.events.some((event) => event.type === T.started)).toBe(false);
  });

  it("a clean verdict runs the script normally", async () => {
    const stream = capabilityHostStream();
    const ran: string[] = [];
    const harness = makeProcessor({
      stream,
      run: async (code) => {
        ran.push(code);
        return 42;
      },
      typecheckScript: async () => ({ verdict: "clean", needsScopeTypes: false }),
    });
    await requestScript(stream, harness);

    await vi.waitFor(() => {
      expect(completion(stream)?.payload).toMatchObject({
        executionId: expect.any(String),
        settlement: { status: "succeeded", result: 42 },
      });
    });
    expect(stream.events.some((event) => event.type === T.started)).toBe(true);
    expect(ran).toHaveLength(1);
  });

  it("skips capability discovery when the platform-only compile emits JavaScript", async () => {
    const stream = new MemoryStream();
    const describeCapabilities = vi.fn(async () => []);
    const typecheckScript = vi.fn(async () => ({
      verdict: "clean" as const,
      emittedJs: "export default 1",
      needsScopeTypes: false,
    }));
    const processor = makeProcessor({
      stream,
      run: async () => "ok",
      path: "/agents/test",
      ancestor: {
        invokeCapability: () => Promise.reject(new Error("unused")),
        describeCapabilities,
      },
      typecheckScript,
    });
    await stream.append({
      type: T.created,
      payload: { config: { ancestorPath: "/" } },
    });
    await requestScript(stream, processor);

    await vi.waitFor(() => expect(completion(stream)).toBeDefined());
    expect(typecheckScript).toHaveBeenCalledTimes(1);
    expect(typecheckScript).toHaveBeenCalledWith({
      capabilities: [],
      code: expect.any(String),
    });
    expect(describeCapabilities).not.toHaveBeenCalled();
    // Preparation now stays inside the foreground request, so its append span
    // has a coherent live parent and closes before executable code is handed
    // back to the caller.
    expect(recordedSpans.map(({ name }) => name)).toEqual([
      "capability_host.script_request_append",
    ]);
  });

  it("an unchecked verdict runs the script (permissive on unknowns)", async () => {
    const stream = capabilityHostStream();
    const ran: string[] = [];
    const harness = makeProcessor({
      stream,
      run: async (code) => {
        ran.push(code);
        return null;
      },
      typecheckScript: async () => ({ verdict: "unchecked", reason: "typechecker unavailable" }),
    });
    await requestScript(stream, harness);

    await vi.waitFor(() => expect(completion(stream)).toBeDefined());
    expect(completion(stream)?.payload).toMatchObject({
      executionId: expect.any(String),
      settlement: { status: "succeeded", result: null },
    });
    expect(ran).toHaveLength(1);
  });

  it("does not lose proven platform problems when the scope recheck is unavailable", async () => {
    const stream = capabilityHostStream();
    const run = vi.fn(async () => null);
    const typecheckScript = vi
      .fn()
      .mockResolvedValueOnce({
        verdict: "problems",
        problems: ["script:1:32 — Property 'gett' does not exist. Did you mean 'get'? (TS2551)"],
      })
      .mockResolvedValueOnce({ verdict: "unchecked", reason: "typechecker unavailable" });
    const harness = makeProcessor({ stream, run, typecheckScript });

    await requestScript(stream, harness);

    await vi.waitFor(() => expect(completion(stream)).toBeDefined());
    expect(typecheckScript).toHaveBeenCalledTimes(2);
    expect(completion(stream)?.payload).toMatchObject({
      settlement: { error: expect.stringContaining("Did you mean 'get'") },
    });
    expect(stream.events.some((event) => event.type === T.started)).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("a THROWING checker runs the script — the gate must never fail a script for its own failure", async () => {
    const stream = capabilityHostStream();
    const ran: string[] = [];
    const harness = makeProcessor({
      stream,
      run: async (code) => {
        ran.push(code);
        return "ok";
      },
      typecheckScript: () => Promise.reject(new Error("sidecar dial failed")),
    });
    await requestScript(stream, harness);

    await vi.waitFor(() => {
      expect(completion(stream)?.payload).toMatchObject({
        executionId: expect.any(String),
        settlement: { status: "succeeded", result: "ok" },
      });
    });
    expect(ran).toHaveLength(1);
  });

  it("no checker wired (node harness) runs the script", async () => {
    const stream = capabilityHostStream();
    const ran: string[] = [];
    const harness = makeProcessor({
      stream,
      run: async (code) => {
        ran.push(code);
        return "ok";
      },
    });
    await requestScript(stream, harness);

    await vi.waitFor(() => expect(completion(stream)).toBeDefined());
    expect(ran).toHaveLength(1);
  });

  it("the checker sees this scope's mounts AND inherited capabilities", async () => {
    const stream = capabilityHostStream("/");
    const seen: CapabilityDescription[][] = [];
    const inherited: CapabilityDescription = {
      path: ["tools", "weather"],
      scope: "/",
      type: "itx-expression",
      types: "export type Forecast = { forecast(): Promise<string> };",
    };
    const harness = makeProcessor({
      stream,
      path: "/agents/test",
      run: async () => null,
      ancestor: {
        invokeCapability: () => Promise.reject(new Error("unused")),
        describeCapabilities: async () => [inherited],
      },
      typecheckScript: async ({ capabilities }) => {
        seen.push(capabilities);
        return { verdict: "clean", needsScopeTypes: capabilities.length === 0 };
      },
    });
    await stream.append({
      type: T.provided,
      payload: { path: ["local"], type: "live", types: "export type Local = { ping(): void };" },
    });
    await requestScript(stream, harness);

    await vi.waitFor(() => expect(completion(stream)).toBeDefined());
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual([]);
    expect(seen[1]!.map((capability) => capability.path.join("."))).toEqual(
      expect.arrayContaining(["local", "tools.weather"]),
    );
  });

  it("returns its durable completion without waiting for a subscription wake or processor fold", async () => {
    const stream = new MemoryStream();
    const run = vi.fn(async () => "ok");
    const harness = makeProcessor({ stream, run });
    await stream.append({
      type: T.created,
      payload: { config: { ancestorPath: null } },
    });
    await harness.runner.catchUp();

    const result = runScript(stream, harness, "async () => null");

    // MemoryStream never wakes processors. Reaching completion proves
    // runScript launched directly from its durable request append without the
    // subscription round-trip.
    await vi.waitFor(() => expect(completion(stream)).toBeDefined());
    expect(run).toHaveBeenCalledTimes(1);

    // MemoryStream also never delivers the completion. The append result is
    // already the authoritative durable outcome, so the foreground call must
    // return without putting the host's processor fold on its latency path.
    await expect(result).resolves.toMatchObject({ result: "ok" });
    expect((await harness.runner.snapshot()).offset).toBe(3);

    // The next host verb starts with catch-up; model that boundary and prove
    // the ordinary fold still closes the obligation exactly once.
    await harness.runner.catchUp();
    expect((await harness.runner.snapshot()).offset).toBe(4);
    expect(
      recordedSpans.find((span) => span.name === "capability_host.script_request_append")
        ?.attributes,
    ).toMatchObject({ "iterate.capability_host.request_offset": 2 });
  });

  it("returns the authoritative completion when a late settlement retries after fold", async () => {
    const stream = capabilityHostStream();
    const harness = makeProcessor({ stream });
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => undefined);
    await harness.runner.catchUp();
    const request = await harness.processor.requestScript(executionIntent("async () => 42"));
    const settlement = { status: "succeeded" as const, result: 42 };
    await harness.runner.catchUp();

    const committed = await harness.processor.settleScriptExecution(
      request.executionId,
      settlement,
    );
    await harness.runner.catchUp();

    try {
      await expect(
        harness.processor.settleScriptExecution(request.executionId, settlement),
      ).resolves.toEqual(committed);
      await expect(
        harness.processor.settleScriptExecution(request.executionId, {
          status: "succeeded",
          result: 43,
        }),
      ).resolves.toEqual(committed);
      expect(consoleInfo).toHaveBeenCalledWith(
        "[capability-host] late script settlement superseded by durable outcome",
        {
          attemptedFailureKind: undefined,
          attemptedStatus: "succeeded",
          durableFailureKind: undefined,
          durableStatus: "succeeded",
          executionId: request.executionId,
        },
      );
    } finally {
      consoleInfo.mockRestore();
    }
  });

  it("reads back the authoritative completion when an unfolded late append loses the race", async () => {
    const stream = capabilityHostStream();
    const harness = makeProcessor({ stream });
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => undefined);
    await harness.runner.catchUp();
    const request = await harness.processor.requestScript(executionIntent("async () => 42"));
    await harness.runner.catchUp();

    const [authoritative] = await stream.append({
      type: T.completed,
      idempotencyKey: request.completionIdempotencyKey,
      payload: {
        executionId: request.executionId,
        settlement: { status: "succeeded", result: 41 },
      },
    });
    expect(authoritative).toBeDefined();

    // Model production's strict idempotency contract while deliberately
    // leaving the runner one offset behind the already durable completion.
    const append = stream.append.bind(stream);
    stream.append = async (...inputs) => {
      for (const input of inputs) {
        const existing =
          input.idempotencyKey === undefined
            ? undefined
            : stream.events.find((event) => event.idempotencyKey === input.idempotencyKey);
        if (
          existing !== undefined &&
          JSON.stringify(existing.payload) !== JSON.stringify(input.payload)
        ) {
          throw new Error(
            `idempotency key "${input.idempotencyKey}" already names a different event`,
          );
        }
      }
      return await append(...inputs);
    };

    try {
      await expect(
        harness.processor.settleScriptExecution(request.executionId, {
          status: "succeeded",
          result: 42,
        }),
      ).resolves.toEqual(authoritative);
      expect(consoleInfo).toHaveBeenCalledWith(
        "[capability-host] late script settlement superseded by durable outcome",
        {
          attemptedFailureKind: undefined,
          attemptedStatus: "succeeded",
          durableFailureKind: undefined,
          durableStatus: "succeeded",
          executionId: request.executionId,
        },
      );
    } finally {
      consoleInfo.mockRestore();
    }
  });

  it("does not put a foreground launch behind the request-fold chain", async () => {
    const stream = capabilityHostStream();
    const run = vi.fn(async () => "ok");
    const requestFold = vi.fn(async () => {
      throw new Error("the request-fold lane is blocked");
    });
    const harness = makeProcessor({
      stream,
      run,
      waitUntilEvent: (input, fallback) =>
        "offset" in input && input.offset === 2 ? requestFold() : fallback(),
    });
    await harness.runner.catchUp();

    await expect(runScript(stream, harness, "async () => null")).resolves.toMatchObject({
      result: "ok",
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(requestFold).not.toHaveBeenCalled();
  });

  it("hands executable code off only after durable started evidence", async () => {
    const stream = capabilityHostStream();
    const run = vi.fn(async () => "ok");
    const harness = makeProcessor({ stream, run });
    await harness.runner.catchUp();

    const request = await harness.processor.requestScript(executionIntent("async () => null"));
    expect(request.preparation).toMatchObject({ status: "ready", code: "async () => null" });
    expect(stream.events.find((event) => event.type === T.started)?.payload).toEqual({
      executionId: request.executionId,
    });
    expect(run).not.toHaveBeenCalled();

    await harness.execute(request);
    await expect(scriptResult(stream, request)).resolves.toMatchObject({ result: "ok" });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("grants one ready handoff and makes every deterministic replay observe it", async () => {
    const stream = capabilityHostStream();
    const run = vi.fn(async () => "ok");
    const harness = makeProcessor({ stream, run });
    const intent = executionIntent("async () => 'ok'");
    await harness.runner.catchUp();

    const first = await harness.processor.requestScript(intent);
    const concurrentReplay = await harness.processor.requestScript(intent);
    expect(first.preparation.status).toBe("ready");
    expect(concurrentReplay.preparation).toEqual({ status: "observe" });

    await harness.execute(first);
    await harness.runner.catchUp();
    const settledReplay = await harness.processor.requestScript(intent);
    expect(settledReplay.preparation).toEqual({ status: "settled" });
    expect(stream.events.filter((event) => event.type === T.requested)).toHaveLength(1);
    expect(stream.events.filter((event) => event.type === T.started)).toHaveLength(1);
    expect(stream.events.filter((event) => event.type === T.completed)).toHaveLength(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("rejects a reused execution id with different immutable input", async () => {
    const stream = capabilityHostStream();
    const setScriptDeadline = vi.fn(async () => undefined);
    const harness = makeProcessor({ stream, setScriptDeadline });
    const intent = executionIntent("async () => 1");
    await harness.runner.catchUp();
    await harness.processor.requestScript(intent);

    await expect(
      harness.processor.requestScript({ ...intent, code: "async () => 2" }),
    ).rejects.toThrow("already requested with different immutable input");
    expect(stream.events.filter((event) => event.type === T.requested)).toHaveLength(1);
    expect(stream.events.filter((event) => event.type === T.started)).toHaveLength(1);
    expect(setScriptDeadline).toHaveBeenCalledExactlyOnceWith(intent.executionId, intent.expiresAt);
  });

  it("executes concurrent requests independently from their foreground drivers", async () => {
    const stream = capabilityHostStream();
    const harness = makeProcessor({
      stream,
      run: async (code) => code,
    });
    await harness.runner.catchUp();

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) => runScript(stream, harness, `async () => ${index}`)),
    );
    expect(results.map(({ result }) => result)).toEqual(
      Array.from({ length: 20 }, (_, index) => `async () => ${index}`),
    );
    expect(stream.events.filter((event) => event.type === T.started)).toHaveLength(20);
    expect(stream.events.filter((event) => event.type === T.completed)).toHaveLength(20);
  });

  it("preserves earlier journal ordering around its committed request", async () => {
    const stream = new MemoryStream();
    const run = vi.fn(async () => "ok");
    const harness = makeProcessor({ stream, run });
    await stream.append({
      type: T.created,
      payload: { config: { ancestorPath: null } },
    });
    await harness.runner.catchUp();
    // This fact wins the next offset but is deliberately not delivered yet.
    await stream.append({ type: "events.iterate.com/agents/user-message-sent", payload: {} });

    const result = runScript(stream, harness, "async () => null");
    await vi.waitFor(() => expect(completion(stream)).toBeDefined());
    expect(run).toHaveBeenCalledTimes(1);
    expect((await harness.runner.snapshot()).offset).toBeGreaterThanOrEqual(3);
    await expect(result).resolves.toMatchObject({ result: "ok" });
    expect(
      recordedSpans.find((span) => span.name === "capability_host.script_request_append")
        ?.attributes,
    ).toMatchObject({ "iterate.capability_host.request_offset": 3 });
  });

  it("drives its committed request when an unconsumed tail suppresses at-head reconciliation", async () => {
    class RequestWithUnconsumedTailStream extends MemoryStream {
      override async append(...inputs: Parameters<MemoryStream["append"]>) {
        const appended = await super.append(...inputs);
        if (inputs.some((input) => input.type === T.requested)) {
          // Reproduces the production ordering: a subscriber lifecycle/agent
          // status fact wins the next offset, but this processor does not
          // consume it. The request is durably folded without receiving the
          // runner's consumed-at-head reconciliation pulse.
          await super.append({
            type: "events.iterate.com/agents/user-message-sent",
            payload: {},
          });
        }
        return appended;
      }
    }

    const stream = new RequestWithUnconsumedTailStream();
    const run = vi.fn(async () => "ok");
    const harness = makeProcessor({ stream, run });
    await stream.append({
      type: T.created,
      payload: { config: { ancestorPath: null } },
    });
    await harness.runner.catchUp();

    const result = runScript(stream, harness, "async () => null");
    await vi.waitFor(() => expect(completion(stream)).toBeDefined());
    expect(run).toHaveBeenCalledTimes(1);

    await expect(result).resolves.toMatchObject({ result: "ok" });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("a rejected execution deletes its obligation — the reconciler never re-runs it", async () => {
    const stream = capabilityHostStream();
    const harness = makeProcessor({
      stream,
      typecheckScript: async () => ({ verdict: "problems", problems: ["script:1 — nope (TS1)"] }),
    });
    await requestScript(stream, harness);
    await vi.waitFor(() => expect(completion(stream)).toBeDefined());

    // A fresh incarnation replays the WHOLE journal (run() throws if invoked):
    // the fold re-creates and deletes the obligation in order, so nothing
    // re-runs and no second completion lands.
    const replay = makeProcessor({ stream });
    await replay.runner.catchUp();
    expect(stream.events.filter((event) => event.type === T.completed)).toHaveLength(1);
    expect(replay.runner.currentState.scriptExecutions).toEqual({});
  });
});
