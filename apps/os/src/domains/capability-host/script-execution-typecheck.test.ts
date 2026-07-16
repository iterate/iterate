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
} from "./capability-host-processor-implementation.ts";

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
  processor: CapabilityHostProcessor;
  runner: StreamProcessorRunner<CapabilityHostProcessorContract>;
};

/** REAL runner drive (the production registry's driver): obligations launch
 * from the runner's at-head `onCaughtUp` pass, fold reads ride the runner's
 * committed progress — exactly as the hosting DO wires registry.reads(...). */
function makeProcessor(options: {
  stream: MemoryStream;
  run?: (code: string) => Promise<unknown>;
  ancestor?: CapabilityHostAncestor;
  path?: string;
  typecheckScript?: (input: {
    capabilities: CapabilityDescription[];
    code: string;
  }) => Promise<ScriptExecutionCheck>;
  runScriptInBackground?: (work: () => Promise<unknown>) => void;
}): Harness {
  let runner!: Harness["runner"];
  const processor = new CapabilityHostProcessor({
    stream: options.stream,
    itx: {} as Project,
    path: options.path ?? "/",
    projectId: null,
    resolveAncestor: options.ancestor === undefined ? undefined : () => options.ancestor!,
    scriptExecutionEntrypoint: {
      run: async (code) => {
        const result = await (
          options.run ??
          (() => {
            throw new Error("must not run in this scenario");
          })
        )(code);
        return {
          status: "succeeded" as const,
          ...(result === undefined ? {} : { result }),
        };
      },
    },
    typecheckScript: options.typecheckScript,
    runScriptInBackground: options.runScriptInBackground,
    reads: {
      snapshot: () => runner.snapshot(),
      waitUntilEvent: (input) =>
        "offset" in input ? runner.waitUntilEvent(input) : runner.waitUntilEvent(input),
    },
  });
  runner = new StreamProcessorRunner({ processor, stream: options.stream });
  return { processor, runner };
}

async function requestScript(stream: MemoryStream, harness: Harness) {
  if (!stream.events.some((event) => event.type === T.created)) {
    await stream.append({
      type: T.created,
      payload: { config: { ancestorPath: null } },
    });
  }
  await stream.append({
    type: T.requested,
    payload: {
      code: "async (itx) => itx.streams.gett('/')",
      executionId: "exec-1",
      expiresAt: Date.now() + 60_000,
    },
  });
  await harness.runner.catchUp();
}

function completion(stream: MemoryStream) {
  return stream.events.find((event) => event.type === T.completed);
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
        executionId: "exec-1",
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
      expect(completed?.idempotencyKey).toBe("capability-host/script-run-settled@exec-1");
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
        executionId: "exec-1",
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
    expect(recordedSpans.map((span) => span.name)).toEqual([
      "capability_host.script_execution",
      "capability_host.script_typecheck",
      "capability_host.script_started_append",
      "capability_host.script_loopback",
      "capability_host.script_completion_append",
      "capability_host.script_completion_consume",
    ]);
    expect(recordedSpans[1]?.attributes).toMatchObject({
      "iterate.capability_host.typecheck_surface": "platform",
      "iterate.capability_host.has_emitted_js": true,
    });
    expect(recordedSpans[0]?.attributes).toMatchObject({
      "iterate.capability_host.script_outcome": "succeeded",
    });
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
      executionId: "exec-1",
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
        executionId: "exec-1",
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

  it("self-pulls its committed request without waiting for a subscription wake", async () => {
    const stream = new MemoryStream();
    const run = vi.fn(async () => "ok");
    const harness = makeProcessor({ stream, run });
    await stream.append({
      type: T.created,
      payload: { config: { ancestorPath: null } },
    });
    await harness.runner.catchUp();

    const result = harness.processor.runScript("async () => null");

    // MemoryStream never wakes processors. Reaching completion proves
    // runScript pulled its committed request through the runner and drove the
    // reconciler without the subscription round-trip.
    await vi.waitFor(() => expect(completion(stream)).toBeDefined());
    expect(run).toHaveBeenCalledTimes(1);

    // MemoryStream also never delivers the completion. The background attempt
    // must fold its own committed completion offset instead of parking the
    // public call on the asynchronous subscription lane.
    await expect(result).resolves.toMatchObject({ result: "ok" });
    expect(
      recordedSpans.find((span) => span.name === "capability_host.script_completion_consume")
        ?.attributes,
    ).toMatchObject({ "iterate.capability_host.completion_offset": 4 });
    expect(
      recordedSpans.find((span) => span.name === "capability_host.script_request_consume")
        ?.attributes,
    ).toMatchObject({ "iterate.capability_host.request_offset": 2 });
  });

  it("keeps concurrent request launches in their foreground RPC owners", async () => {
    const stream = capabilityHostStream();
    const foregroundLaunches = vi.fn();
    const backgroundWork: Promise<unknown>[] = [];
    const harness = makeProcessor({
      stream,
      run: async (code) => code,
      runScriptInBackground: (work) => {
        foregroundLaunches();
        backgroundWork.push(work());
      },
    });
    await harness.runner.catchUp();

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) => harness.processor.runScript(`async () => ${index}`)),
    );
    await Promise.all(backgroundWork);

    expect(foregroundLaunches).toHaveBeenCalledTimes(20);
    expect(results.map(({ result }) => result)).toEqual(
      Array.from({ length: 20 }, (_, index) => `async () => ${index}`),
    );
    expect(
      recordedSpans
        .filter((span) => span.name === "capability_host.script_execution")
        .map((span) => span.attributes["iterate.capability_host.script_launch_owner"]),
    ).toEqual(Array.from({ length: 20 }, () => "foreground"));
  });

  it("folds unseen journal events before consuming its own request", async () => {
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

    const result = harness.processor.runScript("async () => null");
    await vi.waitFor(() => expect(completion(stream)).toBeDefined());
    expect(run).toHaveBeenCalledTimes(1);
    expect((await harness.runner.snapshot()).offset).toBeGreaterThanOrEqual(3);
    await expect(result).resolves.toMatchObject({ result: "ok" });
    expect(
      recordedSpans.find((span) => span.name === "capability_host.script_request_consume")
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

    const result = harness.processor.runScript("async () => null");
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
