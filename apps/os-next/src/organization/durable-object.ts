// src/organization/durable-object.ts — the organization processor's HOST: the class a member's
// `session.organizations.get(orgId).processors.enable("organization")` hosts as the facet named
// `organization` (first-party-facets.ts) — ordinary bundled worker code pulling
// `OrganizationProcessor` from ./processor.ts (the tested spec), exactly as the account's host does.
import { StreamProcessorDurableObject, type ItxEntrypointService } from "iterate/next/sdk";
import type { ItxEntrypointScope } from "../iterate-context.ts";
import { OrganizationProcessor } from "./processor.ts";

export class OrganizationDurableObject extends StreamProcessorDurableObject<
  unknown,
  { ITX?: ItxEntrypointService },
  ItxEntrypointScope
> {
  processor = new OrganizationProcessor();
}
