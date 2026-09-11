// src/account/account-processor-source.ts — the account processor's modules, loaded into a dynamic
// worker facet by `session.user.processors.enable("account", { source, className: "AccountDurableObject" })`.
// It MIRRORS the `reduce` in ./contract.ts (the tested spec); they must stay in step — a loaded
// worker cannot import from src, so the hosted copy is hand-kept. Foundation only: it reduces its own
// account stream, so it needs no D1 (the privileged ctx.exports variant is for the later token effect).

/** The modules, literally (`"cap.js"` is the main module). */
export const ACCOUNT_PROCESSOR_SOURCE = {
  "cap.js": `import { StreamProcessor, StreamProcessorDurableObject, defineProcessorContract, z } from "./processor.js";
const contract = defineProcessorContract({
  slug: "account",
  version: "1.0.0",
  description: "The user's account view: authentications and requested tokens.",
  stateSchema: z.object({
    authentications: z.array(z.object({ credential: z.string(), at: z.number(), operationId: z.string() })).default([]),
    tokens: z.array(z.object({ requestId: z.string(), name: z.string(), requestedAt: z.number() })).default([]),
  }),
  consumes: ["events.iterate.com/account/authenticated", "events.iterate.com/account/token-create-requested"],
  emits: [],
});
class AccountProcessor extends StreamProcessor {
  contract = contract;
  reduce({ event, state }) {
    if (event.type === "events.iterate.com/account/authenticated")
      return { ...state, authentications: [...state.authentications, { credential: event.payload.credential, at: event.payload.at, operationId: event.payload.operationId }] };
    if (event.type === "events.iterate.com/account/token-create-requested")
      return { ...state, tokens: [...state.tokens, { requestId: event.payload.requestId, name: event.payload.name, requestedAt: event.payload.requestedAt }] };
  }
}
export class AccountDurableObject extends StreamProcessorDurableObject {
  processor = new AccountProcessor();
}`,
};
