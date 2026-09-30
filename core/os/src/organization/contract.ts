// src/organization/contract.ts — THE ORGANIZATION: its context, `/organizations/<orgId>` in the
// deployment-global namespace, where its ACTIVITY lands — created, renamed, deleted, a member added
// or removed, an invitation link created, accepted or revoked, a project added or removed — each
// published by the session (session.ts `publishOrganizationFacts`) after the control-plane database
// makes the write, stamped with whoever asked: the audit lives where it happened, attributed to who
// asked and through which connection. THE DATABASE IS THE TRUTH of the organization, its members,
// invitations and projects, and what every reader reads (`session.organizations`); a fact here is
// the record, and the dash's signal to read again. This file is the only place those events and
// their payloads are spelled; processor.ts folds only the catalog of the organization's own
// secrets, and durable-object.ts hosts it as the first-party facet `organization`
// (first-party-facets.ts), the context enabled by the session with the first fact. A PURE FOLD: no
// effect lives here. Every type is derived:
//   OrganizationState = ProcessorState<typeof OrganizationContract>   the reduced state below
//   ConsumedEvent<typeof OrganizationContract>                         what the reduce sees
import { z } from "zod";
import { defineProcessorContract, type ProcessorState } from "iterate/stream/processor";
import { SecretCatalog, SecretContract } from "../secret/contract.ts";

/** What a member is to an organization: an owner runs it (rename, delete, members), a member
 *  reaches its projects. */
export const OrganizationRole = z.enum(["owner", "member"]);
export type OrganizationRole = z.infer<typeof OrganizationRole>;

/** `organization/member-added` — on the organization's log AND on the member's account
 *  (`/users/<userId>`), one spelling: `orgId` names the organization where the log alone does not. */
const MemberAdded = z.object({
  orgId: z.string().min(1),
  userId: z.string().min(1),
  role: OrganizationRole,
});
/** `organization/member-removed` — the mirror, on both logs. */
const MemberRemoved = z.object({ orgId: z.string().min(1), userId: z.string().min(1) });

export const OrganizationContract = defineProcessorContract({
  slug: "organization",
  // A checkpoint reduced under an older version is reused as-is by the engine, so bumping the version
  // is what re-reduces every existing root log.
  version: "6",
  description:
    "The organization's activity — created, renamed, deleted, its members, its invitation links and its projects — and the catalog of its own secrets.",
  /** THE REDUCED STATE: the catalog of the organization's own secrets. Its record is the
   *  control-plane database's (`session.organizations`). */
  stateSchema: z.object({
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
    "events.iterate.com/organization/invitation-created": {
      description:
        "An owner created an invitation link: whoever accepts it first joins in `role`, until `expiresAt` (platform fact).",
      payloadSchema: z.object({
        invitationId: z.string().min(1),
        role: OrganizationRole,
        emailHint: z.string().nullable(),
        expiresAt: z.string(),
      }),
    },
    "events.iterate.com/organization/invitation-accepted": {
      description:
        "A person accepted an invitation link and joined; `member-added` follows (platform fact).",
      payloadSchema: z.object({ invitationId: z.string().min(1), userId: z.string().min(1) }),
    },
    "events.iterate.com/organization/invitation-revoked": {
      description: "An owner withdrew an invitation link before anyone used it (platform fact).",
      payloadSchema: z.object({ invitationId: z.string().min(1) }),
    },
    "events.iterate.com/organization/project-added": {
      description:
        "A project joined the organization's catalog (platform fact): activity, published after the catalog write, whatever becomes of the project's own `project/created`.",
      payloadSchema: z.object({ projectId: z.string().min(1), slug: z.string().min(1) }),
    },
    "events.iterate.com/organization/project-removed": {
      description:
        "A project left the organization's catalog: its owner deleted it, and its own deletion saga is destroying its data (platform fact).",
      payloadSchema: z.object({ projectId: z.string().min(1), slug: z.string().min(1) }),
    },
  },
  // THE RELATIONSHIP: the organization consumes its secrets' certificates without owning them
  // (src/secret/contract.ts: cross-posted from `/organizations/<orgId>/secrets/<name>`).
  processorDeps: [SecretContract],
  consumes: ["events.iterate.com/secret/set", "events.iterate.com/secret/deleted"],
  emits: [],
});

/** The organization's reduced state: its record (the contract's `stateSchema`). */
export type OrganizationState = ProcessorState<typeof OrganizationContract>;
