// src/account/durable-object.ts — the account processor's HOST: the class a dynamic worker facet
// loads (`session.user.processors.enable("account", { source, className: "AccountDurableObject" })`).
//
// THE SINGLE SOURCE. build-sdk.mjs bundles THIS module — pulling `AccountProcessor` from ./processor.ts
// (the tested spec) — into the generated ACCOUNT_PROCESSOR_SOURCE string, leaving the SDK imports
// external as "./processor.js" (the module the host injects into every isolate). So the `reduce` that
// runs in the facet IS the `reduce` the node lane tests: no hand-kept JS twin to drift.
import { StreamProcessorDurableObject } from "../sdk/index.ts";
import { AccountProcessor } from "./processor.ts";

export class AccountDurableObject extends StreamProcessorDurableObject {
  processor = new AccountProcessor();
}
