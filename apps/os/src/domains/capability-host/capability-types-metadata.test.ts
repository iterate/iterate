// The `types` metadata lifecycle at provide time: authored declarations must
// compile before they enter the journal (loud rejection, nothing appended),
// and an itx-expression mount provided WITHOUT types asks the capability's
// __describe once and keeps what it reports — connect-time auto-typing.
// The validator here is a stub; the real one (typechecker sidecar + tswasm)
// is exercised in domains/typecheck/virtual-project.test.ts.

import { describe, expect, it, vi } from "vitest";
import type { Project } from "../../itx-api.generated.ts";
import { MemoryStream } from "../streams/test-helpers.ts";
import type { ProvideCapabilityInput } from "./types.ts";
import { CapabilityHostProcessor } from "./capability-host-processor-implementation.ts";

const PROVIDED = "events.iterate.com/capability-host/capability-provided";

function capabilityHostStream(): MemoryStream {
  const stream = new MemoryStream();
  stream.events.push({
    type: "events.iterate.com/capability-host/created",
    idempotencyKey: `capability-host/created:test:${stream.path}`,
    payload: { config: {} },
    createdAt: new Date().toISOString(),
    offset: 1,
    path: stream.path,
  });
  return stream;
}

/**
 * `provideCapability` awaits read-your-writes delivery of its own append;
 * MemoryStream has no delivery loop, so pump appended events back through
 * `ingest` until the provide settles.
 */
async function provideDelivered(
  processor: CapabilityHostProcessor,
  stream: MemoryStream,
  input: ProvideCapabilityInput,
) {
  const pending = processor.provideCapability(input);
  let settled = false;
  pending.finally(() => (settled = true)).catch(() => {});
  await vi.waitFor(async () => {
    const last = stream.events.at(-1);
    if (last) await processor.ingest({ events: stream.events, streamMaxOffset: last.offset });
    expect(settled).toBe(true);
  });
  return await pending;
}

async function makeProcessor(options: {
  stream: MemoryStream;
  itx?: unknown;
  validateCapabilityTypes?: (types: string) => Promise<string[]>;
}) {
  const processor = new CapabilityHostProcessor({
    stream: options.stream,
    itx: (options.itx ?? {}) as Project,
    path: "/",
    projectId: null,
    scriptExecutionEntrypoint: {
      run: () => {
        throw new Error("must not run in this scenario");
      },
    },
    validateCapabilityTypes: options.validateCapabilityTypes,
  });
  await processor.ingest({
    events: options.stream.events,
    streamMaxOffset: options.stream.events.at(-1)!.offset,
  });
  return processor;
}

describe("CapabilityHostProcessor birth", () => {
  it("throws when a second capability-host birth certificate is reduced", async () => {
    const stream = capabilityHostStream();
    const processor = await makeProcessor({ stream });
    await stream.append({
      type: "events.iterate.com/capability-host/created",
      payload: { config: {} },
    });
    const duplicate = stream.events.at(-1)!;

    await expect(
      processor.ingest({ events: [duplicate], streamMaxOffset: duplicate.offset }),
    ).rejects.toThrow("capability host received more than one created event");
  });
});

describe("provide-time types validation", () => {
  it("rejects authored types that do not compile, appending nothing", async () => {
    const stream = capabilityHostStream();
    const processor = await makeProcessor({
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
    const processor = await makeProcessor({ stream, validateCapabilityTypes: async () => [] });
    await provideDelivered(processor, stream, {
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
    const processor = await makeProcessor({ stream });
    await provideDelivered(processor, stream, {
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
    const processor = await makeProcessor({
      stream,
      itx: { weather: { __describe: async () => ({ types: SELF_DESCRIBED }) } },
      validateCapabilityTypes: async () => [],
    });
    await provideDelivered(processor, stream, {
      expression: ["weather"],
      path: ["forecasts"],
      type: "itx-expression",
    });
    const provided = stream.events.find((event) => event.type === PROVIDED);
    expect(provided?.payload).toMatchObject({ types: SELF_DESCRIBED });
  });

  it("leaves the mount untyped when self-reported types fail to compile", async () => {
    const stream = capabilityHostStream();
    const processor = await makeProcessor({
      stream,
      itx: { weather: { __describe: async () => ({ types: "broken (" }) } },
      validateCapabilityTypes: async () => ["types:1 — expected declaration (TS1128)"],
    });
    await provideDelivered(processor, stream, {
      expression: ["weather"],
      path: ["forecasts"],
      type: "itx-expression",
    });
    const provided = stream.events.find((event) => event.type === PROVIDED);
    expect((provided!.payload as { types?: string }).types).toBeUndefined();
  });

  it("leaves the mount untyped when describing throws, without blocking the provide", async () => {
    const stream = capabilityHostStream();
    const processor = await makeProcessor({
      stream,
      itx: {
        weather: {
          __describe: async () => {
            throw new Error("server offline");
          },
        },
      },
    });
    await provideDelivered(processor, stream, {
      expression: ["weather"],
      path: ["forecasts"],
      type: "itx-expression",
    });
    const provided = stream.events.find((event) => event.type === PROVIDED);
    expect(provided).toBeDefined();
    expect((provided!.payload as { types?: string }).types).toBeUndefined();
  });
});
