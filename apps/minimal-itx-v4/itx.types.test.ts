/// <reference types="@cloudflare/workers-types" />
/// <reference path="./worker-configuration.d.ts" />

import { describe, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { defineProcessorContract } from "@iterate-com/shared/streams/stream-processors";
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
});
