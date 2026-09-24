// src/account/durable-object.ts — THE ACCOUNT HOST: the facet a user's account context hosts under
// the name `account`. Hosted from `ctx.exports` (first-party-facets.ts) — ordinary bundled worker
// code, never a loaded source — and enabled with `processors.enable("account")`, no spec: the
// reserved name IS the class. Nothing beyond the processor: it pulls `AccountProcessor` from
// ./processor.ts (the tested spec), so the `reduce` that runs in the facet IS the `reduce` the unit
// test drives — no hand-kept twin to drift.
import { StreamProcessorDurableObject, type ItxEntrypointService } from "iterate/sdk";
import type { ItxEntrypointScope } from "../iterate-context.ts";
import type { AccountState } from "./contract.ts";
import { AccountProcessor } from "./processor.ts";

export class AccountDurableObject extends StreamProcessorDurableObject<
  AccountState,
  { ITX?: ItxEntrypointService },
  ItxEntrypointScope
> {
  processor = new AccountProcessor();
}
