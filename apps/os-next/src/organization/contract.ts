// src/organization/contract.ts — THE ORGANIZATION: its context, `/organizations/<orgId>` in the
// deployment-global namespace, where the control-plane FACTS about it land — created, renamed,
// deleted, a project created in it — each appended by the session verb that did it (session.ts
// `publishGlobalFact`), stamped with the caller — principal and grant: the audit lives where it
// happened, attributed to who did it and through which connection. This file is the only place
// those events and their payloads are spelled; processor.ts folds them into the record a member
// reads through `session.organizations.get(orgId)`, durable-object.ts hosts it as the first-party
// facet `organization` (first-party-facets.ts), the row enabled where the first fact is published.
// No D1: the directory stays the truth for membership and the current name; this is the record of
// what was done, when, by whom. Every type is derived:
//   OrganizationState = ProcessorState<typeof OrganizationContract>   the reduced state below
//   ConsumedEvent<typeof OrganizationContract>                         what the reduce sees
import { z } from "zod";
import { defineProcessorContract, type ProcessorState } from "iterate/next/stream/processor";
import { SecretCatalog, SecretContract } from "../secret/contract.ts";

export const OrganizationContract = defineProcessorContract({
  slug: "organization",
  // 2: the record grew `secrets` — the organization's own secrets' catalog.
  version: "2",
  description:
    "The organization's record: created, renamed, deleted, every project created in it, and the catalog of its own secrets.",
  /** THE REDUCED STATE — the organization's record, folded from the facts below: what a member
   *  reads through live state. */
  stateSchema: z.object({
    /** The name as last set — created, then renamed; null until the first fact lands. */
    name: z.string().nullable().default(null),
    deletedAt: z.string().nullable().default(null),
    /** Every project created in the organization, by id: its slug and when. */
    projects: z
      .record(z.string(), z.object({ slug: z.string(), createdAt: z.string() }))
      .default({}),
    /** Every secret set under this owner (src/secret/contract.ts): what `itx.secrets.list()` reads here. */
    secrets: SecretCatalog.default({}),
  }),
  events: {
    "events.iterate.com/organization/created": {
      description: "The organization was created; the caller is its owner (platform fact).",
      payloadSchema: z.object({ name: z.string().min(1) }),
    },
    "events.iterate.com/organization/renamed": {
      description: "The organization was renamed (platform fact).",
      payloadSchema: z.object({ name: z.string().min(1) }),
    },
    "events.iterate.com/organization/deleted": {
      description:
        "The organization was deleted from the directory; its context outlives it as the record (platform fact).",
      payloadSchema: z.object({}),
    },
    "events.iterate.com/organization/project-created": {
      description: "A project was created in the organization (platform fact).",
      payloadSchema: z.object({ projectId: z.string().min(1), slug: z.string().min(1) }),
    },
  },
  // THE RELATIONSHIP: the organization consumes its secrets' certificates without owning them
  // (src/secret/contract.ts: cross-posted from `/organizations/<orgId>/secrets/<name>`).
  processorDeps: [SecretContract],
  consumes: [
    "events.iterate.com/organization/created",
    "events.iterate.com/organization/renamed",
    "events.iterate.com/organization/deleted",
    "events.iterate.com/organization/project-created",
    "events.iterate.com/secret/set",
    "events.iterate.com/secret/deleted",
  ],
  emits: [],
});

/** The organization's reduced state: its record (the contract's `stateSchema`). */
export type OrganizationState = ProcessorState<typeof OrganizationContract>;
