// sdk/processor-contract.ts — the zod CONTRACT helper, authored on the SDK side (bundled into
// processor.js for userspace processors). Kept OUT of the edge/DO script on purpose: zod is ~310 KB
// of runtime, and the platform's own core contract needs none of it (it is hand-built in
// stream/core-processor.ts and its events are trusted). Userspace still gets full zod here — a
// processor author writes `defineProcessorContract({ stateSchema: z.object(...), ... })`.
//
// API mirrors apps/os (`packages/iterate/src/processors/schemas.ts`) so processors port both ways.

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
