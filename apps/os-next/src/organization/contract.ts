// src/organization/contract.ts — THE ORGANIZATION: its context, `/organizations/<orgId>` in the
// deployment-global namespace, where the FACTS about it land — created, renamed, deleted, a member
// added or removed, a project created in it — each landed by the control plane on the root
// (src/control-plane/durable-object.ts) right after it writes the row, stamped with whoever asked:
// the audit lives where it happened, attributed to who asked and through which connection. This file is the only place those events and their payloads are spelled; processor.ts
// folds them into the record a member reads through `session.organizations.get(orgId)`'s live
// state (the dash's tree: an organization's projects are THIS fold, bounded per organization);
// durable-object.ts hosts it as the first-party facet `organization` (first-party-facets.ts), the
// row enabled by the control plane with the first fact. A PURE FOLD: no effect lives here. Every
// type is derived:
//   OrganizationState = ProcessorState<typeof OrganizationContract>   the reduced state below
//   ConsumedEvent<typeof OrganizationContract>                         what the reduce sees
import { z } from "zod";
import { defineProcessorContract, type ProcessorState } from "iterate/next/stream/processor";
import { SecretCatalog, SecretContract } from "../secret/contract.ts";

/** What a member is to an organization: an owner runs it (rename, delete, members), a member
 *  reaches its projects. */
export const OrganizationRole = z.enum(["owner", "member"]);
export type OrganizationRole = z.infer<typeof OrganizationRole>;

/** `organization/member-added` — landed on the organization's log AND on the member's account
 *  (`/users/<userId>`, the account fold's `memberships`), one spelling: `orgId` names the
 *  organization where the log alone does not. */
export const MemberAdded = z.object({
  orgId: z.string().min(1),
  userId: z.string().min(1),
  role: OrganizationRole,
});
export type MemberAdded = z.infer<typeof MemberAdded>;
/** `organization/member-removed` — the mirror, on both logs. */
export const MemberRemoved = z.object({ orgId: z.string().min(1), userId: z.string().min(1) });
export type MemberRemoved = z.infer<typeof MemberRemoved>;

export const OrganizationContract = defineProcessorContract({
  slug: "organization",
  // 2: the record grew `secrets`; 3: `members` — who belongs, and as what — folded from the
  // membership facts the control plane lands here.
  version: "3",
  description:
    "The organization's record: created, renamed, deleted, its members, every project created in it, and the catalog of its own secrets.",
  /** THE REDUCED STATE — the organization's record, folded from the facts below: what a member
   *  reads through live state. */
  stateSchema: z.object({
    /** The name as last set — created, then renamed; null until the first fact lands. */
    name: z.string().nullable().default(null),
    deletedAt: z.string().nullable().default(null),
    /** Who belongs, by user id: the role, and since when. Bounded per organization. */
    members: z
      .record(z.string(), z.object({ role: OrganizationRole, since: z.string() }))
      .default({}),
    /** Every project created in the organization, by id: its slug and when. Bounded per
     *  organization — what the dash's tree lists under it. */
    projects: z
      .record(z.string(), z.object({ slug: z.string(), createdAt: z.string() }))
      .default({}),
    /** Every secret set under this owner (src/secret/contract.ts): what `itx.secrets.list()` reads here. */
    secrets: SecretCatalog.default({}),
  }),
  events: {
    "events.iterate.com/organization/created": {
      description: "The organization was created (platform fact).",
      payloadSchema: z.object({ name: z.string().min(1) }),
    },
    "events.iterate.com/organization/renamed": {
      description: "The organization was renamed (platform fact).",
      payloadSchema: z.object({ name: z.string().min(1) }),
    },
    "events.iterate.com/organization/deleted": {
      description:
        "The organization was deleted; its context outlives it as the record (platform fact).",
      payloadSchema: z.object({}),
    },
    "events.iterate.com/organization/member-added": {
      description:
        "A person became a member of the organization, as an owner or a member — on the organization's log and on the person's account (platform fact).",
      payloadSchema: MemberAdded,
    },
    "events.iterate.com/organization/member-removed": {
      description:
        "A person's membership ended — on the organization's log and on the person's account (platform fact).",
      payloadSchema: MemberRemoved,
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
    "events.iterate.com/organization/member-added",
    "events.iterate.com/organization/member-removed",
    "events.iterate.com/organization/project-created",
    "events.iterate.com/secret/set",
    "events.iterate.com/secret/deleted",
  ],
  emits: [],
});

/** The organization's reduced state: its record (the contract's `stateSchema`). */
export type OrganizationState = ProcessorState<typeof OrganizationContract>;
