// The `types` metadata lifecycle at provide time: authored declarations must
// compile before they enter the journal (loud rejection, nothing appended),
// and an itx-expression mount provided WITHOUT types asks the capability's
// __describe once and keeps what it reports — connect-time auto-typing.
// The validator here is a stub; the real one (typechecker sidecar + tswasm)
// is exercised in domains/typecheck/virtual-project.test.ts.

import { describe, expect, it, vi } from "vitest";
import { StreamProcessorRunner } from "iterate/processors";
import { MemoryStream } from "iterate/processors/testing";
import type { Project } from "../../itx-api.generated.ts";
import type { ProvideCapabilityInput } from "./types.ts";
import type { CapabilityHostProcessorContract } from "./capability-host-processor-contract.ts";
import { CapabilityHostProcessor } from "./capability-host-processor-implementation.ts";

const PROVIDED = "events.iterate.com/capability-host/capability-provided";

function capabilityHostStream(): MemoryStream {
  const stream = new MemoryStream();
  stream.events.push({
    type: "events.iterate.com/capability-host/created",
    idempotencyKey: `capability-host/created:test:${stream.path}`,
    payload: { config: { ancestorPath: null } },
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

/**
 * `provideCapability` awaits read-your-writes delivery of its own append;
 * MemoryStream has no delivery loop, so pull the journal through the driving
 * runner until the provide settles.
 */
async function provideDelivered(harness: Harness, input: ProvideCapabilityInput) {
  const pending = harness.processor.provideCapability(input);
  let settled = false;
  pending.finally(() => (settled = true)).catch(() => {});
  await vi.waitFor(async () => {
    await harness.runner.catchUp();
    expect(settled).toBe(true);
  });
  return await pending;
}

/** REAL runner drive (the production registry's driver): the processor's
 * fold reads and read-your-writes waits go through the runner's committed
 * progress, exactly as the hosting DO wires registry.reads(...). */
async function makeProcessor(options: {
  stream: MemoryStream;
  itx?: unknown;
  path?: string;
  validateCapabilityTypes?: (types: string) => Promise<string[]>;
}): Promise<Harness> {
  let runner!: Harness["runner"];
  const processor = new CapabilityHostProcessor({
    stream: options.stream,
    itx: (options.itx ?? {}) as Project,
    path: options.path ?? "/",
    projectId: null,
    setScriptDeadline: async () => undefined,
    validateCapabilityTypes: options.validateCapabilityTypes,
    reads: {
      snapshot: () => runner.snapshot(),
      waitUntilEvent: (input) =>
        "offset" in input ? runner.waitUntilEvent(input) : runner.waitUntilEvent(input),
    },
  });
  runner = new StreamProcessorRunner({ processor, stream: options.stream });
  await runner.catchUp();
  return { processor, runner };
}

describe("CapabilityHostProcessor birth", () => {
  it("throws when a second capability-host birth certificate is reduced", async () => {
    const stream = capabilityHostStream();
    const harness = await makeProcessor({ stream });
    await stream.append({
      type: "events.iterate.com/capability-host/created",
      payload: { config: { ancestorPath: null } },
    });

    await expect(harness.runner.catchUp()).rejects.toThrow(
      "capability host received more than one created event",
    );
  });

  it("rejects reads through an uncreated container instead of inferring a parent", async () => {
    const harness = await makeProcessor({
      stream: new MemoryStream("/agents"),
      path: "/agents",
    });

    await expect(
      harness.processor.invokeCapability({ path: ["projectTool", "ping"], args: [] }),
    ).rejects.toThrow("capability host at /agents has not been created");
  });
});

describe("provide-time types validation", () => {
  it("rejects authored types that do not compile, appending nothing", async () => {
    const stream = capabilityHostStream();
    const { processor } = await makeProcessor({
      stream,
      validateCapabilityTypes: async () => ["types:1 — Cannot find name 'Streem'. (TS2304)"],
    });
    await expect(
      processor.provideCapability({
        expression: ["streams"],
        path: ["broken"],
        type: "itx-expression",
        types: "export type Broken = Streem;",
      }),
    ).rejects.toThrow(/does not compile[\s\S]*Streem/);
    expect(stream.events.filter((event) => event.type === PROVIDED)).toEqual([]);
  });

  it("journals authored types that compile", async () => {
    const stream = capabilityHostStream();
    const harness = await makeProcessor({ stream, validateCapabilityTypes: async () => [] });
    await provideDelivered(harness, {
      expression: ["streams"],
      path: ["root"],
      type: "itx-expression",
      types: "export type Root = Stream;",
    });
    const provided = stream.events.find((event) => event.type === PROVIDED);
    expect(provided?.payload).toMatchObject({ types: "export type Root = Stream;" });
  });

  it("skips validation when no validator is wired (node harness)", async () => {
    const stream = capabilityHostStream();
    const harness = await makeProcessor({ stream });
    await provideDelivered(harness, {
      expression: ["streams"],
      path: ["unchecked"],
      type: "itx-expression",
      types: "utter garbage (",
    });
    expect(stream.events.find((event) => event.type === PROVIDED)).toBeDefined();
  });
});

describe("connect-time auto-typing", () => {
  const SELF_DESCRIBED = "export type Capability = { forecast(): Promise<string> };";

  it("stamps an expression mount's types from the capability's own __describe", async () => {
    const stream = capabilityHostStream();
    const harness = await makeProcessor({
      stream,
      itx: { weather: { __describe: async () => ({ types: SELF_DESCRIBED }) } },
      validateCapabilityTypes: async () => [],
    });
    await provideDelivered(harness, {
      expression: ["weather"],
      path: ["forecasts"],
      type: "itx-expression",
    });
    const provided = stream.events.find((event) => event.type === PROVIDED);
    expect(provided?.payload).toMatchObject({ types: SELF_DESCRIBED });
  });

  it("leaves the mount untyped when self-reported types fail to compile", async () => {
    const stream = capabilityHostStream();
    const harness = await makeProcessor({
      stream,
      itx: { weather: { __describe: async () => ({ types: "broken (" }) } },
      validateCapabilityTypes: async () => ["types:1 — expected declaration (TS1128)"],
    });
    await provideDelivered(harness, {
      expression: ["weather"],
      path: ["forecasts"],
      type: "itx-expression",
    });
    const provided = stream.events.find((event) => event.type === PROVIDED);
    expect((provided!.payload as { types?: string }).types).toBeUndefined();
  });

  it("leaves the mount untyped when describing throws, without blocking the provide", async () => {
    const stream = capabilityHostStream();
    const harness = await makeProcessor({
      stream,
      itx: {
        weather: {
          __describe: async () => {
            throw new Error("server offline");
          },
        },
      },
    });
    await provideDelivered(harness, {
      expression: ["weather"],
      path: ["forecasts"],
      type: "itx-expression",
    });
    const provided = stream.events.find((event) => event.type === PROVIDED);
    expect(provided).toBeDefined();
    expect((provided!.payload as { types?: string }).types).toBeUndefined();
  });
});
