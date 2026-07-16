import { describe, expect, it, vi } from "vitest";
import type { Project } from "../../itx-api.generated.ts";
import { StreamProcessorRunner } from "../streams/stream-processor-runner.ts";
import { MemoryStream } from "../streams/test-helpers.ts";
import type { CapabilityHostProcessorContract } from "./capability-host-processor-contract.ts";
import {
  CapabilityHostProcessor,
  type CapabilityHostAncestor,
} from "./capability-host-processor-implementation.ts";

const ANCESTOR_CONFIGURED = "events.iterate.com/capability-host/ancestor-configured" as const;

function makeProcessor(input: {
  path: string;
  resolveAncestor: (path: string) => CapabilityHostAncestor;
  stream: MemoryStream;
}) {
  let runner!: StreamProcessorRunner<CapabilityHostProcessorContract>;
  const processor = new CapabilityHostProcessor({
    stream: input.stream,
    itx: {} as Project,
    path: input.path,
    projectId: null,
    resolveAncestor: input.resolveAncestor,
    reads: {
      snapshot: () => runner.snapshot(),
      waitUntilEvent: (args) =>
        "offset" in args ? runner.waitUntilEvent(args) : runner.waitUntilEvent(args),
    },
    scriptExecutionEntrypoint: {
      run: () => {
        throw new Error("must not run in this scenario");
      },
    },
  });
  runner = new StreamProcessorRunner({ processor, stream: input.stream });
  return { processor, runner };
}

describe("explicit capability-host ancestors", () => {
  it("resolves exactly the declared ancestor, never intermediate path prefixes", async () => {
    const stream = new MemoryStream();
    const invokeCapability = vi.fn(async () => "from-root");
    const root: CapabilityHostAncestor = {
      describeCapabilities: async () => [],
      invokeCapability,
    };
    const resolveAncestor = vi.fn(() => root);
    const { processor, runner } = makeProcessor({
      path: "/agents/web/2026-07-15t21-56-48-076z",
      resolveAncestor,
      stream,
    });
    await stream.append({
      type: ANCESTOR_CONFIGURED,
      payload: { ancestorPath: "/" },
    });
    await runner.catchUp();

    await expect(processor.invokeCapability({ path: ["projectTool"] })).resolves.toBe("from-root");
    expect(resolveAncestor).toHaveBeenCalledTimes(1);
    expect(resolveAncestor).toHaveBeenCalledWith("/");
    expect(invokeCapability).toHaveBeenCalledWith({ args: [], path: ["projectTool"] }, [
      "/agents/web/2026-07-15t21-56-48-076z",
    ]);
  });

  it("keeps local mounts ahead of the declared ancestor when describing the scope", async () => {
    const stream = new MemoryStream();
    const describeCapabilities = vi.fn(async () => [
      { path: ["local"], scope: "/", type: "live" as const },
      { path: ["projectTool"], scope: "/", type: "live" as const },
    ]);
    const { processor, runner } = makeProcessor({
      path: "/agents/web/conversation",
      resolveAncestor: () => ({
        describeCapabilities,
        invokeCapability: async () => null,
      }),
      stream,
    });
    await stream.append(
      { type: ANCESTOR_CONFIGURED, payload: { ancestorPath: "/" } },
      {
        type: "events.iterate.com/capability-host/capability-provided",
        payload: { path: ["local"], type: "live" },
      },
    );
    await runner.catchUp();

    await expect(processor.describeCapabilities()).resolves.toMatchObject([
      { path: ["local"], scope: "/agents/web/conversation" },
      { path: ["projectTool"], scope: "/" },
    ]);
    expect(describeCapabilities).toHaveBeenCalledTimes(1);
  });

  it("rejects an unconfigured host without consulting a path prefix", async () => {
    const stream = new MemoryStream();
    const resolveAncestor = vi.fn(() => {
      throw new Error("must not infer an ancestor");
    });
    const { processor } = makeProcessor({
      path: "/agents/web/unconfigured-conversation",
      resolveAncestor,
      stream,
    });

    await expect(processor.invokeCapability({ path: ["projectTool"] })).rejects.toThrow(
      'capability-host "/agents/web/unconfigured-conversation" has no ancestor declaration',
    );
    await expect(processor.describeCapabilities()).rejects.toThrow(
      'capability-host "/agents/web/unconfigured-conversation" has no ancestor declaration',
    );
    await expect(processor.runScript("async () => null")).rejects.toThrow(
      'capability-host "/agents/web/unconfigured-conversation" has no ancestor declaration',
    );
    expect(resolveAncestor).not.toHaveBeenCalled();
    expect(stream.events).toEqual([]);
  });

  it("fails a configured ancestor cycle with the full bounded traversal", async () => {
    const streamA = new MemoryStream();
    const streamB = new MemoryStream();
    let hostA!: CapabilityHostProcessor;
    let hostB!: CapabilityHostProcessor;
    let runnerA!: StreamProcessorRunner<CapabilityHostProcessorContract>;
    let runnerB!: StreamProcessorRunner<CapabilityHostProcessorContract>;
    ({ processor: hostA, runner: runnerA } = makeProcessor({
      path: "/agents/a",
      resolveAncestor: () => hostB,
      stream: streamA,
    }));
    ({ processor: hostB, runner: runnerB } = makeProcessor({
      path: "/agents/b",
      resolveAncestor: () => hostA,
      stream: streamB,
    }));
    await streamA.append({
      type: ANCESTOR_CONFIGURED,
      payload: { ancestorPath: "/agents/b" },
    });
    await streamB.append({
      type: ANCESTOR_CONFIGURED,
      payload: { ancestorPath: "/agents/a" },
    });
    await runnerA.catchUp();
    await runnerB.catchUp();

    await expect(hostA.describeCapabilities()).rejects.toThrow(
      "capability-host ancestor cycle: /agents/a -> /agents/b -> /agents/a",
    );
  });
});
