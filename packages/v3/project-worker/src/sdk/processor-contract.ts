// sdk/processor-contract.ts — the zod CONTRACT helper, on the SDK side only: zod is ~310 KB of
// runtime the edge/DO script never needs (the core contract is hand-built, stream/core-processor.ts).
// Mirrors apps/os (`packages/iterate/src/processors/schemas.ts`) so processors port both ways.

import { z } from "zod";
import type { ProcessorContract } from "../stream/processor.ts";

export function defineProcessorContract<StateSchema extends z.ZodType>(contract: {
  slug: string;
  version: string;
  description: string;
  /** Must parse `{}` — the initial state is `stateSchema.parse({})` (all fields defaulted). */
  stateSchema: StateSchema;
  consumes: readonly string[];
  emits: readonly string[];
}): ProcessorContract<z.infer<StateSchema>> & { stateSchema: StateSchema } {
  const initial = contract.stateSchema.safeParse({});
  if (!initial.success)
    throw new Error(`contract "${contract.slug}": stateSchema must parse {} (default every field)`);
  return {
    slug: contract.slug,
    version: contract.version,
    description: contract.description,
    consumes: contract.consumes,
    emits: contract.emits,
    stateSchema: contract.stateSchema,
    initialState: () => contract.stateSchema.parse({}) as z.infer<StateSchema>,
  };
}
