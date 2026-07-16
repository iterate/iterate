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
  ancestorConfigured: "events.iterate.com/capability-host/ancestor-configured",
  provided: "events.iterate.com/capability-host/capability-provided",
  requested: "events.iterate.com/capability-host/script-execution-requested",
  started: "events.iterate.com/capability-host/script-execution-started",
  completed: "events.iterate.com/capability-host/script-execution-completed",
} as const;

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
}): Harness {
  let runner!: Harness["runner"];
  const processor = new CapabilityHostProcessor({
    stream: options.stream,
    itx: {} as Project,
    path: options.path ?? "/",
    projectId: null,
    resolveAncestor: options.ancestor === undefined ? undefined : () => options.ancestor!,
    scriptExecutionEntrypoint: {
      run:
        options.run ??
        (() => {
          throw new Error("must not run in this scenario");
        }),
    },
    typecheckScript: options.typecheckScript,
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
  if (!stream.events.some((event) => event.type === T.ancestorConfigured)) {
    await stream.append({
      type: T.ancestorConfigured,
      payload: { ancestorPath: null },
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
  it("settles a directly journaled request on an unconfigured host without running it", async () => {
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
        error: expect.stringContaining("has no ancestor declaration"),
      }),
    );
    expect(stream.events.some((event) => event.type === T.started)).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("a problems verdict settles as an error completion — never started, never run", async () => {
    const stream = new MemoryStream();
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
        error: expect.stringContaining("NOT executed"),
      });
      expect((completed!.payload as { error: string }).error).toContain("Did you mean 'get'");
      // Shared with the run/settle lanes, so a race collapses to one completion.
      expect(completed?.idempotencyKey).toBe("capability-host/script-execution-completed@exec-1");
    });
    expect(stream.events.some((event) => event.type === T.started)).toBe(false);
  });

  it("a clean verdict runs the script normally", async () => {
    const stream = new MemoryStream();
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
      expect(completion(stream)?.payload).toMatchObject({ executionId: "exec-1", result: 42 });
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
      type: T.ancestorConfigured,
      payload: { ancestorPath: "/" },
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
    const stream = new MemoryStream();
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
    expect(completion(stream)?.payload).not.toHaveProperty("error");
    expect(ran).toHaveLength(1);
  });

  it("a THROWING checker runs the script — the gate must never fail a script for its own failure", async () => {
    const stream = new MemoryStream();
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
      expect(completion(stream)?.payload).toMatchObject({ executionId: "exec-1", result: "ok" });
    });
    expect(ran).toHaveLength(1);
  });

  it("no checker wired (node harness) runs the script", async () => {
    const stream = new MemoryStream();
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
    const stream = new MemoryStream();
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
      type: "events.iterate.com/capability-host/ancestor-configured",
      payload: { ancestorPath: "/" },
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
      type: T.ancestorConfigured,
      payload: { ancestorPath: null },
    });
    await harness.runner.catchUp();

    const result = harness.processor.runScript("async () => null");

    // MemoryStream never wakes processors. Reaching completion proves
    // runScript pulled its committed request through the runner and drove the
    // reconciler without the subscription round-trip.
    await vi.waitFor(() => expect(completion(stream)).toBeDefined());
    expect(run).toHaveBeenCalledTimes(1);

    // Deliver the resulting started/completed facts so the public method's
    // future-event waiter observes the durable completion, as production's
    // normal subscription lane does.
    await harness.runner.catchUp();
    await expect(result).resolves.toMatchObject({ result: "ok" });
    expect(
      recordedSpans.find((span) => span.name === "capability_host.script_request_consume")
        ?.attributes,
    ).toMatchObject({ "iterate.capability_host.request_offset": 2 });
  });

  it("folds unseen journal events before consuming its own request", async () => {
    const stream = new MemoryStream();
    const run = vi.fn(async () => "ok");
    const harness = makeProcessor({ stream, run });
    await stream.append({
      type: T.ancestorConfigured,
      payload: { ancestorPath: null },
    });
    await harness.runner.catchUp();
    // This fact wins the next offset but is deliberately not delivered yet.
    await stream.append({ type: "events.iterate.com/agents/user-message-sent", payload: {} });

    const result = harness.processor.runScript("async () => null");
    await vi.waitFor(() => expect(completion(stream)).toBeDefined());
    expect(run).toHaveBeenCalledTimes(1);
    expect((await harness.runner.snapshot()).offset).toBeGreaterThanOrEqual(3);
    await harness.runner.catchUp();
    await expect(result).resolves.toMatchObject({ result: "ok" });
    expect(
      recordedSpans.find((span) => span.name === "capability_host.script_request_consume")
        ?.attributes,
    ).toMatchObject({ "iterate.capability_host.request_offset": 3 });
  });

  it("a rejected execution deletes its obligation — the reconciler never re-runs it", async () => {
    const stream = new MemoryStream();
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
