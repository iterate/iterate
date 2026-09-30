// src/email/durable-object.ts — the email processor's HOST: the first-party facet `email`
// (first-party-facets.ts) on a project's `/integrations/email`, hosted from `ctx.exports`. Its row is
// enabled before the platform records a message there (integrations/email.ts), idempotently.
import { StreamProcessorDurableObject, type ItxEntrypointService } from "iterate/sdk";
import type { EmailState } from "iterate/email";
import type { ItxEntrypointScope } from "../iterate-context.ts";
import { EmailProcessor } from "./processor.ts";

export class EmailDurableObject extends StreamProcessorDurableObject<
  EmailState,
  { ITX?: ItxEntrypointService },
  ItxEntrypointScope
> {
  processor = new EmailProcessor();
}
