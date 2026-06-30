/// <reference types="@cloudflare/workers-types" />
/// <reference path="./worker-configuration.d.ts" />

import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  buildEvent,
  defineProcessorContract,
} from "./src/domains/streams/engine/shared/stream-processors.ts";
import type { StreamEvent } from "./src/types.ts";
import { StreamProcessor } from "./src/domains/streams/engine/stream-processor.ts";

type IsNever<Value> = [Value] extends [never] ? true : false;

type HelloWorldEvent = {
  type: "hello-world";
  payload?: unknown;
};

declare class ProofStreamDurableObject implements Rpc.DurableObjectBranded {
  [Rpc.__DURABLE_OBJECT_BRAND]: never;

  append(event: { type: "hello-world" }): HelloWorldEvent[];
  at(path: string): ProofStreamDurableObject;
}

describe("Cloudflare Durable Object RPC types", () => {
  it("keeps DurableObjectNamespace.getByName RPC returns from collapsing to never", () => {
    // Regression proof for workerd#5200:
    // https://github.com/cloudflare/workerd/issues/5200
    //
    // `payload?: unknown` makes HelloWorldEvent fail Cloudflare's recursive
    // Rpc.Serializable<R> test. Without @cloudflare__workers-types.patch,
    // DurableObjectNamespace<ProofStreamDurableObject> turns append() into
    // `never`; with the patch it remains the RPC promise shape we can await.
    function assertGeneratedWorkerEnvStreamAppend(env: {
      STREAM: DurableObjectNamespace<ProofStreamDurableObject>;
    }) {
      const events = env.STREAM.getByName("bla").append({ type: "hello-world" });

      expectTypeOf<IsNever<typeof events>>().toEqualTypeOf<false>();
      expectTypeOf(events).toExtend<Promise<HelloWorldEvent[] & Disposable>>();
    }

    void assertGeneratedWorkerEnvStreamAppend;
  });

  it("keeps generated ctx.exports Durable Object loopback returns from collapsing to never", () => {
    // This matches ProjectDurableObject's real path:
    //
    //   this.ctx.exports.StreamDurableObject.getByName(...).append(...)
    //
    // `ctx.exports` is typed via Cloudflare.Exports, not Env["STREAM"], so this
    // covers the loopback export path that generated worker types expose for
    // Durable Object classes listed in Cloudflare.GlobalProps.durableNamespaces.
    function assertGeneratedExportsStreamAppend(ctx: DurableObjectState) {
      const stream = ctx.exports.StreamDurableObject.getByName("bla");
      const appended = stream.append({
        type: "events.iterate.com/project/created",
        payload: { projectId: "prj_ref" },
      });
      const waited = stream.waitForEvent({
        eventTypes: ["events.iterate.com/project/created"],
        timeoutMs: 5_000,
      });

      expectTypeOf<IsNever<typeof appended>>().toEqualTypeOf<false>();
      expectTypeOf<IsNever<typeof waited>>().toEqualTypeOf<false>();
      // Loopback DO calls are still RPC calls. The important guarantee is that
      // they are awaitable stream events, not synchronous events and not `never`.
      expectTypeOf(appended).toExtend<Promise<StreamEvent[] & Disposable>>();
      expectTypeOf(waited).toExtend<Promise<StreamEvent & Disposable>>();
    }

    void assertGeneratedExportsStreamAppend;
  });
});

describe("stream processor type helpers", () => {
  it("buildEvent narrows catalog events even with wildcard consumes and emits", () => {
    const DependencyContract = defineProcessorContract({
      slug: "build-event-dependency",
      version: "0.1.0",
      description: "Dependency processor used to prove dependency event inference.",
      stateSchema: z.object({}),
      initialState: {},
      events: {
        "events.iterate.test/build-event/dependency-output": {
          payloadSchema: z.object({ accepted: z.boolean() }),
        },
      },
      consumes: [],
      emits: ["events.iterate.test/build-event/dependency-output"],
    });

    const WildcardConsumesContract = defineProcessorContract({
      slug: "build-event-wildcard-consumes",
      version: "0.1.0",
      description: "Wildcard consumer used to prove buildEvent stays catalog-bound.",
      stateSchema: z.object({}),
      initialState: {},
      processorDeps: [DependencyContract],
      events: {
        "events.iterate.test/build-event/local-output": {
          payloadSchema: z.object({ value: z.string() }),
        },
      },
      consumes: ["*"],
      emits: [
        "events.iterate.test/build-event/dependency-output",
        "events.iterate.test/build-event/local-output",
      ],
    });

    const local = buildEvent({
      contract: WildcardConsumesContract,
      event: {
        type: "events.iterate.test/build-event/local-output",
        payload: { value: "ok" },
      },
    });
    expectTypeOf(local.type).toEqualTypeOf<"events.iterate.test/build-event/local-output">();
    expectTypeOf(local.payload.value).toMatchTypeOf<string>();
    // @ts-expect-error local event payload does not include dependency fields
    local.payload.accepted;

    const dependency = buildEvent({
      contract: WildcardConsumesContract,
      event: {
        type: "events.iterate.test/build-event/dependency-output",
        payload: { accepted: true },
      },
    });
    expectTypeOf(
      dependency.type,
    ).toEqualTypeOf<"events.iterate.test/build-event/dependency-output">();
    expectTypeOf(dependency.payload.accepted).toMatchTypeOf<boolean>();
    // @ts-expect-error dependency event payload does not include local fields
    dependency.payload.value;

    const StructuralWildcardEmitsContract = {
      slug: "build-event-structural-wildcard-emits",
      processorDeps: [DependencyContract],
      events: {
        "events.iterate.test/build-event/structural-local": {
          payloadSchema: z.object({ label: z.string() }),
        },
      },
      consumes: [] as const,
      emits: ["*"] as const,
    };

    const structuralLocal = buildEvent({
      contract: StructuralWildcardEmitsContract,
      event: {
        type: "events.iterate.test/build-event/structural-local",
        payload: { label: "ok" },
      },
    });
    expectTypeOf(
      structuralLocal.type,
    ).toEqualTypeOf<"events.iterate.test/build-event/structural-local">();
    expectTypeOf(structuralLocal.payload.label).toMatchTypeOf<string>();

    const structuralDependency = buildEvent({
      contract: StructuralWildcardEmitsContract,
      event: {
        type: "events.iterate.test/build-event/dependency-output",
        payload: { accepted: false },
      },
    });
    expectTypeOf(
      structuralDependency.type,
    ).toEqualTypeOf<"events.iterate.test/build-event/dependency-output">();
    expectTypeOf(structuralDependency.payload.accepted).toMatchTypeOf<boolean>();

    function assertInvalidBuildEvents() {
      buildEvent({
        contract: WildcardConsumesContract,
        // @ts-expect-error wildcard consumes does not make arbitrary events buildable
        event: { type: "events.iterate.test/build-event/unknown", payload: {} },
      });

      buildEvent({
        contract: WildcardConsumesContract,
        event: {
          type: "events.iterate.test/build-event/local-output",
          // @ts-expect-error payload shape must match the selected event type
          payload: { value: 123 },
        },
      });

      buildEvent({
        contract: StructuralWildcardEmitsContract,
        // @ts-expect-error wildcard emits does not make arbitrary events buildable
        event: { type: "events.iterate.test/build-event/not-owned", payload: {} },
      });
    }
    void assertInvalidBuildEvents;
  });

  it("narrows hook append helpers to the processor emits contract", () => {
    const ToyProcessorContract = defineProcessorContract({
      slug: "toy",
      version: "0.1.0",
      description: "Toy processor used to prove emitted append helper narrowing.",
      stateSchema: z.object({}),
      events: {
        "events.iterate.com/toy/consumed": {
          payloadSchema: z.object({ input: z.string() }),
        },
        "events.iterate.com/toy/emitted": {
          payloadSchema: z.object({ output: z.string() }),
        },
        "events.iterate.com/toy/other": {
          payloadSchema: z.object({ nope: z.boolean() }),
        },
      },
      consumes: ["events.iterate.com/toy/consumed"],
      emits: ["events.iterate.com/toy/emitted"],
    });

    class ToyProcessor extends StreamProcessor<typeof ToyProcessorContract> {
      readonly contract = ToyProcessorContract;

      protected override processEvent({
        append,
      }: Parameters<StreamProcessor<typeof ToyProcessorContract>["processEvent"]>[0]): undefined {
        const appended = append({
          type: "events.iterate.com/toy/emitted",
          payload: { output: "ok" },
        });
        expectTypeOf(appended).toExtend<Promise<StreamEvent[]>>();

        append(
          {
            type: "events.iterate.com/toy/emitted",
            payload: { output: "batch-a" },
          },
          {
            type: "events.iterate.com/toy/emitted",
            payload: { output: "batch-b" },
          },
        );

        this.stream.at("../sibling").append({
          type: "events.iterate.com/toy/emitted",
          payload: { output: "cross-stream" },
        });

        type AppendInput = Parameters<typeof append>[0];

        expectTypeOf<{
          type: "events.iterate.com/toy/consumed";
          payload: { input: string };
        }>().not.toExtend<AppendInput>();

        expectTypeOf<{
          type: "events.iterate.com/toy/other";
          payload: { nope: boolean };
        }>().not.toExtend<AppendInput>();

        expectTypeOf<{
          type: "events.iterate.com/toy/emitted";
          payload: { input: string };
        }>().not.toExtend<AppendInput>();
      }
    }

    void ToyProcessor;
  });

  it("rejects local event definitions that conflict with processor deps", () => {
    const OwnerContract = defineProcessorContract({
      slug: "event-owner",
      version: "0.1.0",
      description: "Owns the event type.",
      stateSchema: z.object({}),
      initialState: {},
      events: {
        "events.iterate.test/owned-once": {
          payloadSchema: z.object({ owner: z.string() }),
        },
      },
      consumes: [],
      emits: ["events.iterate.test/owned-once"],
    });

    expect(() =>
      defineProcessorContract({
        slug: "event-shadow",
        version: "0.1.0",
        description: "Incorrectly shadows a dependency event type.",
        stateSchema: z.object({}),
        initialState: {},
        processorDeps: [OwnerContract],
        events: {
          "events.iterate.test/owned-once": {
            payloadSchema: z.object({ shadow: z.boolean() }),
          },
        },
        consumes: ["events.iterate.test/owned-once"],
        emits: [],
      }),
    ).toThrow(
      'Processor "event-shadow" defines event "events.iterate.test/owned-once" that is already owned by processor dependency "event-owner".',
    );
  });
});
