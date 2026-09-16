// src/account/durable-object.ts — the account processor's HOST: the class a dynamic worker facet
// loads (`session.user.processors.enable("account", { source, className: "AccountDurableObject" })`).
//
// THE SINGLE SOURCE, hosted from `ctx.exports` (first-party-facets.ts): ordinary bundled worker code
// pulling `AccountProcessor` from ./processor.ts (the tested spec).
// external as "./processor.js" (the module the host injects into every isolate). So the `reduce` that
// runs in the facet IS the `reduce` the node lane tests: no hand-kept JS twin to drift.
import { StreamProcessorDurableObject, type ItxEntrypointService } from "iterate/next/sdk";
import type { ItxEntrypointScope } from "../iterate-context.ts";
import { AccountProcessor } from "./processor.ts";

export class AccountDurableObject extends StreamProcessorDurableObject<
  unknown,
  { ITX?: ItxEntrypointService },
  ItxEntrypointScope
> {
  processor = new AccountProcessor();
}
