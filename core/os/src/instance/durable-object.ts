// src/instance/durable-object.ts — the instance processor's HOST: the first-party facet `instance`
// (first-party-facets.ts) on the global root `global:/`, hosted from `ctx.exports`. Its row is
// enabled with the first certificate of a deployment secret (context/built-ins.ts), idempotently.
import { StreamProcessorDurableObject, type ItxEntrypointService } from "iterate/sdk";
import type { ItxEntrypointScope } from "../iterate-context.ts";
import type { InstanceState } from "./contract.ts";
import { InstanceProcessor } from "./processor.ts";

export class InstanceDurableObject extends StreamProcessorDurableObject<
  InstanceState,
  { ITX?: ItxEntrypointService },
  ItxEntrypointScope
> {
  processor = new InstanceProcessor();
}
