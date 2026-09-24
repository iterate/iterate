// src/organization/contract.ts — THE ORGANIZATION: its context, `/organizations/<orgId>` in the
// deployment-global namespace, where the FACTS about it land — created, renamed, deleted, a member
// added or removed, an invitation link created, accepted or revoked, a project created in it — each
// landed by the session on the context (session.ts `foldPlatformFacts`) right after the
// control-plane database writes the row,
// stamped with whoever asked: the audit lives where it happened, attributed to who asked and through
// which connection. This file is the only place those events and their payloads are spelled; processor.ts
// folds them into the record a member reads through `session.organizations.get(orgId)`'s live
// state (the dash's tree: an organization's projects are THIS fold, bounded per organization);
// durable-object.ts hosts it as the first-party facet `organization` (first-party-facets.ts), the
// context enabled by the session with the first fact. A PURE FOLD: no effect lives here. Every
// type is derived:
//   OrganizationState = ProcessorState<typeof OrganizationContract>   the reduced state below
//   ConsumedEvent<typeof OrganizationContract>                         what the reduce sees
import { z } from "zod";
import { defineProcessorContract, type ProcessorState } from "iterate/stream/processor";
import { SecretCatalog, SecretContract } from "../secret/contract.ts";

/** What a member is to an organization: an owner runs it (rename, delete, members), a member
 *  reaches its projects. */
export const OrganizationRole = z.enum(["owner", "member"]);
export type OrganizationRole = z.infer<typeof OrganizationRole>;

/** `organization/member-added` — landed on the organization's log AND on the member's account
 *  (`/users/<userId>`, the account fold's `memberships`), one spelling: `orgId` names the
 *  organization where the log alone does not. */
const MemberAdded = z.object({
  orgId: z.string().min(1),
  userId: z.string().min(1),
  role: OrganizationRole,
  /** The organization's FIRST membership, landed by the project creation that minted the
   *  organization (session.ts `landProjectOnOrganization`). The account folds it by its own rule
   *  (account/processor.ts). */
  mint: z.literal(true).optional(),
});
/** `organization/member-removed` — the mirror, on both logs. */
const MemberRemoved = z.object({ orgId: z.string().min(1), userId: z.string().min(1) });

type Memberships = Record<string, { role: OrganizationRole; since: string }>;

/** The membership fold both logs share — the organization's `members` keyed by user, the account's
 *  `memberships` keyed by organization. The latest role is the row; the first membership's time
 *  stays. The same role again is a no-op (undefined). */
export function reduceMembership(
  map: Memberships,
  key: string,
  role: OrganizationRole,
  at: string,
): Memberships | undefined {
  const known = map[key];
  if (known?.role === role) return undefined;
  return { ...map, [key]: { role, since: known?.since ?? at } };
}

/** A membership's removal from either map; undefined when there was none. */
export function dropMembership(map: Memberships, key: string): Memberships | undefined {
  if (!map[key]) return undefined;
  const { [key]: _gone, ...rest } = map;
  return rest;
}

export const OrganizationContract = defineProcessorContract({
  slug: "organization",
  // A checkpoint reduced under an older version is reused as-is by the engine, so bumping the version
  // is what re-reduces every existing root log.
  version: "4",
  description:
    "The organization's record: created, renamed, deleted, its members, its pending invitation links, every project created in it, and the catalog of its own secrets.",
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
    /** The invitation links still open, by invitation id — created and neither accepted nor
     *  revoked (an expired one stays until revoked: the dash says it expired). The link's secret
     *  is never here: the control-plane database holds its hash, and the owner saw it once. */
    invitations: z
      .record(
        z.string(),
        z.object({
          role: OrganizationRole,
          emailHint: z.string().nullable(),
          expiresAt: z.string(),
          createdAt: z.string(),
        }),
      )
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
    "events.iterate.com/organization/project-created": {
      description:
        "A project joined the organization's catalog (platform fact). It lands before, and whatever becomes of, the project's own `project/created`.",
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
    "events.iterate.com/organization/invitation-created",
    "events.iterate.com/organization/invitation-accepted",
    "events.iterate.com/organization/invitation-revoked",
    "events.iterate.com/organization/project-created",
    "events.iterate.com/secret/set",
    "events.iterate.com/secret/deleted",
  ],
  emits: [],
});

/** The organization's reduced state: its record (the contract's `stateSchema`). */
export type OrganizationState = ProcessorState<typeof OrganizationContract>;
