import { describe, expectTypeOf, it } from "vitest";
import type { StreamEvent, StreamEventInput } from "./types-and-schemas.ts";

type IsNever<Value> = [Value] extends [never] ? true : false;
type IsUnknown<Value> = unknown extends Value ? ([Value] extends [unknown] ? true : false) : false;

describe("minimal ITX Wrangler-generated stream proof", () => {
  it("keeps generated durable object stubs usable for append APIs", () => {
    if (false) {
      const env = {} as TypesAndSchemasProofEnv;
      const stub = env.PROOF_STREAM.getByName("proof");

      type AppendInput = Parameters<typeof stub.append>[0];
      type AppendBatchInput = Parameters<typeof stub.appendBatch>[0];

      const appendResult = stub.append({
        event: { type: "events.iterate.com/proof/increment", payload: { amount: 1 } },
      });
      const appendBatchResult = stub.appendBatch({
        events: [{ type: "events.iterate.com/proof/increment", payload: { amount: 1 } }],
      });

      expectTypeOf<AppendInput>().toEqualTypeOf<{
        event: StreamEventInput;
      }>();
      expectTypeOf<AppendBatchInput>().toEqualTypeOf<{
        events: StreamEventInput[];
      }>();

      expectTypeOf<IsNever<typeof appendResult>>().toEqualTypeOf<false>();
      expectTypeOf<IsNever<typeof appendBatchResult>>().toEqualTypeOf<false>();
      expectTypeOf<IsNever<Awaited<typeof appendResult>>>().toEqualTypeOf<false>();
      expectTypeOf<IsNever<Awaited<typeof appendBatchResult>>>().toEqualTypeOf<false>();
      expectTypeOf<IsUnknown<Awaited<typeof appendResult>>>().toEqualTypeOf<false>();
      expectTypeOf<IsUnknown<Awaited<typeof appendBatchResult>>>().toEqualTypeOf<false>();

      expectTypeOf(appendResult).toMatchTypeOf<Promise<StreamEvent & Disposable>>();
      expectTypeOf(appendBatchResult).toMatchTypeOf<Promise<StreamEvent[] & Disposable>>();
      expectTypeOf<Awaited<typeof appendResult>>().toMatchTypeOf<StreamEvent & Disposable>();
      expectTypeOf<Awaited<typeof appendBatchResult>>().toMatchTypeOf<StreamEvent[] & Disposable>();
    }
  });
});
