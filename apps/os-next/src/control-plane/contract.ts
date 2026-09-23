// src/control-plane/contract.ts — THE CONTROL PLANE'S RECORD: the events the root context
// `global:/` appends to its own log after every write the control plane makes
// (durable-object.ts) — a user, an identity, an organization, a membership, a project. The TABLES in
// the facet's SQLite are the truth (catalog.ts); these are the after-the-fact record of every
// change, what an operator reads and anything may subscribe to. Nothing reduces them. This file is
// the only place they are spelled.
import { z } from "zod";
import { defineProcessorContract } from "iterate/next/stream/processor";
import { OrganizationRole } from "../organization/contract.ts";

/** The sign-in providers that prove who someone is (identity.ts): each names a person by a stable
 *  subject; a person links at most ONE subject per provider. */
export const IdentityProvider = z.enum(["google", "cloudflare"]);
export type IdentityProvider = z.infer<typeof IdentityProvider>;

export const ControlPlaneContract = defineProcessorContract({
  slug: "control-plane",
  version: "1",
  description:
    "The control plane's record on the root log: every user, identity, organization, membership and project it writes, after the fact.",
  stateSchema: z.object({}),
  events: {
    "events.iterate.com/control-plane/user-created": {
      description: "A person has an account, found by this email from now on.",
      payloadSchema: z.object({ userId: z.string().min(1), email: z.string().min(1) }),
    },
    "events.iterate.com/control-plane/user-email-changed": {
      description: "A verified identity reported a new email for the person.",
      payloadSchema: z.object({ userId: z.string().min(1), email: z.string().min(1) }),
    },
    "events.iterate.com/control-plane/identity-linked": {
      description: "The provider's subject names this person.",
      payloadSchema: z.object({
        userId: z.string().min(1),
        provider: IdentityProvider,
        subject: z.string().min(1),
      }),
    },
    "events.iterate.com/control-plane/organization-created": {
      description:
        "The organization exists; `ownerId` is null for the deployment's own, which has no members.",
      payloadSchema: z.object({
        orgId: z.string().min(1),
        name: z.string().min(1),
        ownerId: z.string().min(1).nullable(),
      }),
    },
    "events.iterate.com/control-plane/organization-renamed": {
      description: "The organization was renamed.",
      payloadSchema: z.object({ orgId: z.string().min(1), name: z.string().min(1) }),
    },
    "events.iterate.com/control-plane/organization-deleted": {
      description: "The organization was deleted, its memberships with it.",
      payloadSchema: z.object({ orgId: z.string().min(1) }),
    },
    "events.iterate.com/control-plane/member-added": {
      description: "A person became an owner or a member of the organization.",
      payloadSchema: z.object({
        orgId: z.string().min(1),
        userId: z.string().min(1),
        role: OrganizationRole,
      }),
    },
    "events.iterate.com/control-plane/member-removed": {
      description: "A person's membership ended.",
      payloadSchema: z.object({ orgId: z.string().min(1), userId: z.string().min(1) }),
    },
    "events.iterate.com/control-plane/project-created": {
      description: "The project exists, its slug held in the organization named.",
      payloadSchema: z.object({
        projectId: z.string().min(1),
        slug: z.string().min(1),
        orgId: z.string().min(1),
      }),
    },
  },
  consumes: [],
  emits: [
    "events.iterate.com/control-plane/user-created",
    "events.iterate.com/control-plane/user-email-changed",
    "events.iterate.com/control-plane/identity-linked",
    "events.iterate.com/control-plane/organization-created",
    "events.iterate.com/control-plane/organization-renamed",
    "events.iterate.com/control-plane/organization-deleted",
    "events.iterate.com/control-plane/member-added",
    "events.iterate.com/control-plane/member-removed",
    "events.iterate.com/control-plane/project-created",
  ],
});
