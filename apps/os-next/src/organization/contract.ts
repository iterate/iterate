// src/organization/contract.ts — the organization context's vocabulary and pure reducer (the
// triplet's first: processor.ts is the fold, durable-object.ts the host). The control-plane FACTS
// that happen TO an organization — created, renamed, deleted, a project created in it — are
// appended to its own context, `/organizations/<orgId>` in the deployment-global namespace, by the
// session verb that did it (session.ts `publishGlobalFact`), stamped with the caller — principal
// and grant: the audit lives where it happened, attributed to who did it and through which
// connection. The `OrganizationProcessor` folds them into a view a member reads through
// `session.organizations.get(orgId)` — the same StreamProcessor kernel every project processor
// uses, hosted on demand like the account's. No D1: the directory stays the truth for membership
// and the current name; this is the record of what was done, when, by whom.
import { z } from "zod";
import { defineProcessorContract } from "iterate/next/stream/processor";

export const OrganizationView = z.object({
  /** The name as last set — created, then renamed; null until the first fact lands. */
  name: z.string().nullable().default(null),
  deletedAt: z.string().nullable().default(null),
  /** Every project created in the organization, by id: its slug and when. */
  projects: z.record(z.string(), z.object({ slug: z.string(), createdAt: z.string() })).default({}),
});
/** The organization's reduced state: its record. */
export type OrganizationView = z.infer<typeof OrganizationView>;

export const OrganizationContract = defineProcessorContract({
  slug: "organization",
  version: "1",
  description:
    "The organization's record: created, renamed, deleted, and every project created in it.",
  stateSchema: OrganizationView,
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
  consumes: [
    "events.iterate.com/organization/created",
    "events.iterate.com/organization/renamed",
    "events.iterate.com/organization/deleted",
    "events.iterate.com/organization/project-created",
  ],
  emits: [],
});
