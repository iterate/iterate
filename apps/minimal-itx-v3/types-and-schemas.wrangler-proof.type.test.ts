import { describe, expectTypeOf, it } from "vitest";
import type { Stream, StreamEvent, StreamEventInput } from "./types-and-schemas.ts";
import { ProofStreamDurableObject } from "./types-and-schemas.wrangler-proof.worker.ts";

type IsNever<Value> = [Value] extends [never] ? true : false;
type IsUnknown<Value> = unknown extends Value ? ([Value] extends [unknown] ? true : false) : false;

describe("minimal ITX Wrangler-generated stream proof", () => {
  it("keeps generated durable object stubs usable for append APIs", () => {
    expectTypeOf<ProofStreamDurableObject>().toMatchTypeOf<Stream>();

    if (false) {
      const env = {} as TypesAndSchemasProofEnv;
      const stub = env.PROOF_STREAM.getByName("proof");

      type AppendInput = Parameters<typeof stub.append>[0];
      type AppendBatchInput = Parameters<typeof stub.appendBatch>[0];
      type AppendResult = ReturnType<typeof stub.append>;
      type AppendBatchResult = ReturnType<typeof stub.appendBatch>;

      expectTypeOf<AppendInput>().toEqualTypeOf<{ event: StreamEventInput }>();
      expectTypeOf<AppendBatchInput>().toEqualTypeOf<{ events: StreamEventInput[] }>();

      expectTypeOf<IsNever<AppendResult>>().toEqualTypeOf<false>();
      expectTypeOf<IsNever<AppendBatchResult>>().toEqualTypeOf<false>();
      expectTypeOf<IsNever<Awaited<AppendResult>>>().toEqualTypeOf<false>();
      expectTypeOf<IsNever<Awaited<AppendBatchResult>>>().toEqualTypeOf<false>();
      expectTypeOf<IsUnknown<Awaited<AppendResult>>>().toEqualTypeOf<false>();
      expectTypeOf<IsUnknown<Awaited<AppendBatchResult>>>().toEqualTypeOf<false>();

      expectTypeOf<AppendResult>().toMatchTypeOf<Promise<StreamEvent & Disposable>>();
      expectTypeOf<AppendBatchResult>().toMatchTypeOf<Promise<StreamEvent[] & Disposable>>();
      expectTypeOf<Awaited<AppendResult>>().toMatchTypeOf<StreamEvent & Disposable>();
      expectTypeOf<Awaited<AppendBatchResult>>().toMatchTypeOf<StreamEvent[] & Disposable>();
    }
  });
});
