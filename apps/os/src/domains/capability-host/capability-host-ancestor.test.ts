import { describe, expect, it, vi } from "vitest";
import type { Project } from "../../itx-api.generated.ts";
import { MemoryStream } from "../streams/test-helpers.ts";
import {
  CapabilityHostProcessor,
  type CapabilityHostAncestor,
} from "./capability-host-processor-implementation.ts";

const ANCESTOR_CONFIGURED = "events.iterate.com/capability-host/ancestor-configured" as const;

function makeProcessor(input: {
  legacyAncestorPath?: string | null;
  path: string;
  resolveAncestor: (path: string) => CapabilityHostAncestor;
  stream: MemoryStream;
}) {
  return new CapabilityHostProcessor({
    stream: input.stream,
    itx: {} as Project,
    path: input.path,
    projectId: null,
    ...(input.legacyAncestorPath === undefined
      ? {}
      : { legacyAncestorPath: input.legacyAncestorPath }),
    resolveAncestor: input.resolveAncestor,
    scriptExecutionEntrypoint: {
      run: () => {
        throw new Error("must not run in this scenario");
      },
    },
  });
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
    const processor = makeProcessor({
      path: "/agents/web/2026-07-15t21-56-48-076z",
      resolveAncestor,
      stream,
    });
    await stream.append({
      type: ANCESTOR_CONFIGURED,
      payload: { ancestorPath: "/" },
    });
    await processor.ingest({ events: stream.events, streamMaxOffset: 1 });

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
    const processor = makeProcessor({
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
    await processor.ingest({ events: stream.events, streamMaxOffset: 2 });

    await expect(processor.describeCapabilities()).resolves.toMatchObject([
      { path: ["local"], scope: "/agents/web/conversation" },
      { path: ["projectTool"], scope: "/" },
    ]);
    expect(describeCapabilities).toHaveBeenCalledTimes(1);
  });

  it("journals the pre-0.2 relationship once before using it", async () => {
    const stream = new MemoryStream();
    const root: CapabilityHostAncestor = {
      describeCapabilities: async () => [],
      invokeCapability: async () => "migrated-root",
    };
    const processor = makeProcessor({
      legacyAncestorPath: "/",
      path: "/agents/web/legacy-conversation",
      resolveAncestor: () => root,
      stream,
    });

    const pending = processor.invokeCapability({ path: ["projectTool"] });
    await vi.waitFor(() => {
      expect(stream.events).toHaveLength(1);
      expect(stream.events[0]).toMatchObject({
        type: ANCESTOR_CONFIGURED,
        payload: { ancestorPath: "/" },
      });
    });
    await processor.ingest({ events: stream.events, streamMaxOffset: 1 });
    await expect(pending).resolves.toBe("migrated-root");

    await expect(processor.invokeCapability({ path: ["projectTool"] })).resolves.toBe(
      "migrated-root",
    );
    expect(stream.events).toHaveLength(1);
  });

  it("fails a configured ancestor cycle with the full bounded traversal", async () => {
    const streamA = new MemoryStream();
    const streamB = new MemoryStream();
    let hostA!: CapabilityHostProcessor;
    let hostB!: CapabilityHostProcessor;
    hostA = makeProcessor({
      path: "/agents/a",
      resolveAncestor: () => hostB,
      stream: streamA,
    });
    hostB = makeProcessor({
      path: "/agents/b",
      resolveAncestor: () => hostA,
      stream: streamB,
    });
    await streamA.append({
      type: ANCESTOR_CONFIGURED,
      payload: { ancestorPath: "/agents/b" },
    });
    await streamB.append({
      type: ANCESTOR_CONFIGURED,
      payload: { ancestorPath: "/agents/a" },
    });
    await hostA.ingest({ events: streamA.events, streamMaxOffset: 1 });
    await hostB.ingest({ events: streamB.events, streamMaxOffset: 1 });

    await expect(hostA.describeCapabilities()).rejects.toThrow(
      "capability-host ancestor cycle: /agents/a -> /agents/b -> /agents/a",
    );
  });
});
