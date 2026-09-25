// src/organization/durable-object.ts — the organization processor's HOST: the first-party facet
// `organization` (first-party-facets.ts) on the context at `/organizations/<orgId>`, hosted from
// `ctx.exports` — ordinary bundled worker code pulling `OrganizationProcessor` from ./processor.ts,
// exactly as the account's host does. Its row is enabled with the first fact the session lands
// after a control-plane write (session.ts), idempotently.
import { StreamProcessorDurableObject, type ItxEntrypointService } from "iterate/sdk";
import type { ItxEntrypointScope } from "../iterate-context.ts";
import type { OrganizationState } from "./contract.ts";
import { OrganizationProcessor } from "./processor.ts";

export class OrganizationDurableObject extends StreamProcessorDurableObject<
  OrganizationState,
  { ITX?: ItxEntrypointService },
  ItxEntrypointScope
> {
  processor = new OrganizationProcessor();
}
