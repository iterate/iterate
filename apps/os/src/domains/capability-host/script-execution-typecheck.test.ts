// The pre-execution typecheck gate: a `problems` verdict settles the request
// as an error completion WITHOUT running it (and without a started event —
// the gate has no side effects, so a rejected script provably never ran);
// every other outcome — clean, unchecked, a throwing checker, no checker
// wired at all — lets the script run. The verdict policy itself (what counts
// as a provable problem) lives in checkItxScriptForExecution and is tested
// against the real compiler in domains/typecheck/virtual-project.test.ts;
// here the checker is a stub and the subject is the gate's plumbing.

import { describe, expect, it, vi } from "vitest";
import type { Project } from "../../itx-api.generated.ts";
import type { CapabilityDescription } from "../itx/describe.ts";
import type { ScriptExecutionCheck } from "../typecheck/virtual-project.ts";
import { MemoryStream } from "../streams/test-helpers.ts";
import {
  CapabilityHostProcessor,
  type ParentCapabilityHost,
} from "./capability-host-processor-implementation.ts";

const T = {
  provided: "events.iterate.com/capability-host/capability-provided",
  requested: "events.iterate.com/capability-host/script-execution-requested",
  started: "events.iterate.com/capability-host/script-execution-started",
  completed: "events.iterate.com/capability-host/script-execution-completed",
} as const;

function makeProcessor(options: {
  stream: MemoryStream;
  run?: (code: string) => Promise<unknown>;
  parent?: ParentCapabilityHost;
  typecheckScript?: (input: {
    capabilities: CapabilityDescription[];
    code: string;
  }) => Promise<ScriptExecutionCheck>;
}) {
  return new CapabilityHostProcessor({
    stream: options.stream,
    itx: {} as Project,
    path: "/",
    projectId: null,
    parent: options.parent,
    scriptExecutionEntrypoint: {
      run:
        options.run ??
        (() => {
          throw new Error("must not run in this scenario");
        }),
    },
    typecheckScript: options.typecheckScript,
  });
}

async function requestScript(stream: MemoryStream, processor: CapabilityHostProcessor) {
  const [requested] = await stream.append({
    type: T.requested,
    payload: { code: "async (itx) => itx.streams.gett('/')", executionId: "exec-1" },
  });
  await processor.ingest({ events: stream.events, streamMaxOffset: requested!.offset });
}

function completion(stream: MemoryStream) {
  return stream.events.find((event) => event.type === T.completed);
}

describe("script execution typecheck gate", () => {
  it("a problems verdict settles as an error completion — never started, never run", async () => {
    const stream = new MemoryStream();
    const processor = makeProcessor({
      stream,
      typecheckScript: async () => ({
        verdict: "problems",
        problems: ["script:1:32 — Property 'gett' does not exist. Did you mean 'get'? (TS2551)"],
      }),
    });
    await requestScript(stream, processor);

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
    const processor = makeProcessor({
      stream,
      run: async (code) => {
        ran.push(code);
        return 42;
      },
      typecheckScript: async () => ({ verdict: "clean" }),
    });
    await requestScript(stream, processor);

    await vi.waitFor(() => {
      expect(completion(stream)?.payload).toMatchObject({ executionId: "exec-1", result: 42 });
    });
    expect(stream.events.some((event) => event.type === T.started)).toBe(true);
    expect(ran).toHaveLength(1);
  });

  it("an unchecked verdict runs the script (permissive on unknowns)", async () => {
    const stream = new MemoryStream();
    const ran: string[] = [];
    const processor = makeProcessor({
      stream,
      run: async (code) => {
        ran.push(code);
        return null;
      },
      typecheckScript: async () => ({ verdict: "unchecked", reason: "typechecker unavailable" }),
    });
    await requestScript(stream, processor);

    await vi.waitFor(() => expect(completion(stream)).toBeDefined());
    expect(completion(stream)?.payload).not.toHaveProperty("error");
    expect(ran).toHaveLength(1);
  });

  it("a THROWING checker runs the script — the gate must never fail a script for its own failure", async () => {
    const stream = new MemoryStream();
    const ran: string[] = [];
    const processor = makeProcessor({
      stream,
      run: async (code) => {
        ran.push(code);
        return "ok";
      },
      typecheckScript: () => Promise.reject(new Error("sidecar dial failed")),
    });
    await requestScript(stream, processor);

    await vi.waitFor(() => {
      expect(completion(stream)?.payload).toMatchObject({ executionId: "exec-1", result: "ok" });
    });
    expect(ran).toHaveLength(1);
  });

  it("no checker wired (node harness) runs the script", async () => {
    const stream = new MemoryStream();
    const ran: string[] = [];
    const processor = makeProcessor({
      stream,
      run: async (code) => {
        ran.push(code);
        return "ok";
      },
    });
    await requestScript(stream, processor);

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
    const processor = makeProcessor({
      stream,
      run: async () => null,
      parent: {
        invokeCapability: () => Promise.reject(new Error("unused")),
        describeCapabilities: async () => [inherited],
      },
      typecheckScript: async ({ capabilities }) => {
        seen.push(capabilities);
        return { verdict: "clean" };
      },
    });
    await stream.append({
      type: T.provided,
      payload: { path: ["local"], type: "live", types: "export type Local = { ping(): void };" },
    });
    await requestScript(stream, processor);

    await vi.waitFor(() => expect(completion(stream)).toBeDefined());
    expect(seen).toHaveLength(1);
    expect(seen[0]!.map((capability) => capability.path.join("."))).toEqual(
      expect.arrayContaining(["local", "tools.weather"]),
    );
  });

  it("a rejected execution deletes its obligation — the reconciler never re-runs it", async () => {
    const stream = new MemoryStream();
    const processor = makeProcessor({
      stream,
      typecheckScript: async () => ({ verdict: "problems", problems: ["script:1 — nope (TS1)"] }),
    });
    await requestScript(stream, processor);
    await vi.waitFor(() => expect(completion(stream)).toBeDefined());

    // Deliver everything again (a later batch after the completion): the fold
    // holds no obligation, so nothing re-runs and no second completion lands.
    const last = stream.events.at(-1)!;
    await processor.ingest({ events: stream.events, streamMaxOffset: last.offset });
    expect(stream.events.filter((event) => event.type === T.completed)).toHaveLength(1);
    expect(processor.state.scriptExecutions).toEqual({});
  });
});
