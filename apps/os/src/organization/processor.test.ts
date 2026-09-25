// src/organization/processor.test.ts — the OrganizationProcessor's executable spec: declarative
// `{ events → state }` rows on the shared processor harness (iterate/stream/test-support
// `reduceProcessor`): the pure reduce, with the engine's contract validation (a malformed KNOWN
// payload is skipped).
import { expect, test } from "vitest";
import { reduceProcessor } from "iterate/stream/test-support";
import { OrganizationProcessor } from "./processor.ts";
import { type OrganizationState } from "./contract.ts";

/** Every fact the organization folds is the platform's: stamped `source.platform` as its writer
 *  stamps it (session.ts `foldPlatformFacts`). */
const platform = { origin: "/", platform: true } as const;
const created = (name: string) => ({
  type: "events.iterate.com/organization/created",
  payload: { name },
  source: platform,
});
const invitation = (
  verb: "created" | "accepted" | "revoked",
  payload: Record<string, unknown>,
) => ({
  type: `events.iterate.com/organization/invitation-${verb}`,
  payload,
  source: platform,
});
const projectAdded = (projectId: string, slug: string) => ({
  type: "events.iterate.com/organization/project-added",
  payload: { projectId, slug },
  source: platform,
});

const projectRemoved = (projectId: string, slug: string) => ({
  type: "events.iterate.com/organization/project-removed",
  payload: { projectId, slug },
  source: platform,
});

const rows: {
  name: string;
  events: { type: string; payload?: unknown; source?: typeof platform }[];
  state: OrganizationState;
}[] = [
  {
    name: "the empty record",
    events: [],
    state: { name: null, deletedAt: null, members: {}, invitations: {}, projects: {}, secrets: {} },
  },
  {
    name: "a project removed leaves the record; one never added changes nothing",
    events: [
      created("Booper"),
      projectAdded("prj_1", "monkey"),
      projectRemoved("prj_1", "monkey"),
      projectRemoved("prj_9", "never"),
    ],
    state: {
      name: "Booper",
      deletedAt: null,
      members: {},
      invitations: {},
      projects: {},
      secrets: {},
    },
  },
  {
    name: "created sets the name, renamed replaces it; a project added to it is a row by id, stamped with the event's time; the same project again is ignored",
    events: [
      created("Booper"),
      projectAdded("prj_1", "monkey"),
      {
        type: "events.iterate.com/organization/renamed",
        payload: { name: "Booper Inc" },
        source: platform,
      },
      projectAdded("prj_1", "monkey"),
      projectAdded("prj_2", "voice"),
    ],
    state: {
      name: "Booper Inc",
      deletedAt: null,
      members: {},
      invitations: {},
      projects: {
        prj_1: { slug: "monkey", createdAt: expect.any(String) },
        prj_2: { slug: "voice", createdAt: expect.any(String) },
      },
      secrets: {},
    },
  },
  {
    name: "a member added is a row by user id with the role and the first membership's time; the same role again is ignored, a new role replaces it; removed drops the row",
    events: [
      created("Booper"),
      {
        type: "events.iterate.com/organization/member-added",
        payload: { orgId: "org_1", userId: "user_a", role: "owner" },
        source: platform,
      },
      {
        type: "events.iterate.com/organization/member-added",
        payload: { orgId: "org_1", userId: "user_a", role: "owner" },
        source: platform,
      },
      {
        type: "events.iterate.com/organization/member-added",
        payload: { orgId: "org_1", userId: "user_b", role: "member" },
        source: platform,
      },
      {
        type: "events.iterate.com/organization/member-added",
        payload: { orgId: "org_1", userId: "user_b", role: "owner" },
        source: platform,
      },
      {
        type: "events.iterate.com/organization/member-removed",
        payload: { orgId: "org_1", userId: "user_a" },
        source: platform,
      },
      {
        type: "events.iterate.com/organization/member-removed",
        payload: { orgId: "org_1", userId: "user_zzz" },
        source: platform,
      },
    ],
    state: {
      name: "Booper",
      deletedAt: null,
      members: { user_b: { role: "owner", since: new Date(4000).toISOString() } },
      invitations: {},
      projects: {},
      secrets: {},
    },
  },
  {
    name: "an invitation link created is a pending row by id, stamped with the event's time; the same id again is ignored; accepted or revoked, the row goes; one never created is nothing to drop",
    events: [
      created("Booper"),
      invitation("created", {
        invitationId: "inv_a",
        role: "member",
        emailHint: "ada@example.com",
        expiresAt: "2030-01-01T00:00:00.000Z",
      }),
      invitation("created", {
        invitationId: "inv_a",
        role: "owner",
        emailHint: null,
        expiresAt: "2031-01-01T00:00:00.000Z",
      }),
      invitation("created", {
        invitationId: "inv_b",
        role: "owner",
        emailHint: null,
        expiresAt: "2030-01-01T00:00:00.000Z",
      }),
      invitation("created", {
        invitationId: "inv_c",
        role: "member",
        emailHint: null,
        expiresAt: "2030-01-01T00:00:00.000Z",
      }),
      invitation("accepted", { invitationId: "inv_b", userId: "user_b" }),
      invitation("revoked", { invitationId: "inv_c" }),
      invitation("revoked", { invitationId: "inv_zzz" }),
    ],
    state: {
      name: "Booper",
      deletedAt: null,
      members: {},
      invitations: {
        inv_a: {
          role: "member",
          emailHint: "ada@example.com",
          expiresAt: "2030-01-01T00:00:00.000Z",
          createdAt: new Date(2000).toISOString(),
        },
      },
      projects: {},
      secrets: {},
    },
  },
  {
    name: "deleted stamps the record once and keeps it; an unrelated event leaves the state as it was",
    events: [
      created("Booper"),
      { type: "note", payload: { n: 1 } },
      { type: "events.iterate.com/organization/deleted", payload: {}, source: platform },
      { type: "events.iterate.com/organization/deleted", payload: {}, source: platform },
    ],
    state: {
      name: "Booper",
      deletedAt: expect.any(String),
      members: {},
      invitations: {},
      projects: {},
      secrets: {},
    },
  },
  {
    name: "a malformed payload for a KNOWN type is skipped by the contract, never reduced",
    events: [
      {
        type: "events.iterate.com/organization/created",
        payload: { name: "" },
        source: platform,
      },
      {
        type: "events.iterate.com/organization/project-added",
        payload: { projectId: "x" },
        source: platform,
      },
      created("Booper"),
    ],
    state: {
      name: "Booper",
      deletedAt: null,
      members: {},
      invitations: {},
      projects: {},
      secrets: {},
    },
  },
  {
    name: "a fact the platform did not write — a member appended it to the organization's context — is folded by nothing",
    events: [
      created("Booper"),
      { type: "events.iterate.com/organization/renamed", payload: { name: "Forged" } },
      { type: "events.iterate.com/organization/deleted", payload: {} },
      {
        type: "events.iterate.com/organization/member-added",
        payload: { orgId: "org_1", userId: "user_forged", role: "owner" },
      },
      {
        type: "events.iterate.com/organization/project-added",
        payload: { projectId: "prj_f", slug: "forged" },
      },
      {
        type: "events.iterate.com/organization/invitation-created",
        payload: { invitationId: "inv_f", role: "owner", emailHint: null, expiresAt: "2030" },
      },
    ],
    state: {
      name: "Booper",
      deletedAt: null,
      members: {},
      invitations: {},
      projects: {},
      secrets: {},
    },
  },
];
for (const { name, events, state } of rows)
  test(`OrganizationProcessor — the organization's record folded from facts: ${name}`, () =>
    expect(reduceProcessor(new OrganizationProcessor(), events)).toEqual(state));
