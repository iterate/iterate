// src/organization/processor.test.ts — the OrganizationProcessor's executable spec: declarative
// `{ events → state }` rows on the shared processor harness (stream/test-support.ts
// `reduceProcessor`): the pure reduce, with the engine's contract validation (a malformed KNOWN
// payload is skipped).
import { describe, expect, test } from "vitest";
import { reduceProcessor } from "../stream/test-support.ts";
import { OrganizationProcessor } from "./processor.ts";
import { type OrganizationState } from "./contract.ts";

/** Every fact the organization folds is the platform's: stamped `source.platform` as its writer
 *  stamps it (session.ts `foldPlatformFacts`). */
const platform = { platform: true } as const;
const created = (name: string) => ({
  type: "events.iterate.com/organization/created",
  payload: { name },
  source: platform,
});
const projectCreated = (projectId: string, slug: string) => ({
  type: "events.iterate.com/organization/project-created",
  payload: { projectId, slug },
  source: platform,
});

describe("OrganizationProcessor — the organization's record folded from facts", () => {
  const rows: {
    name: string;
    events: { type: string; payload?: unknown; source?: typeof platform }[];
    state: OrganizationState;
  }[] = [
    {
      name: "the empty record",
      events: [],
      state: { name: null, deletedAt: null, members: {}, projects: {}, secrets: {} },
    },
    {
      name: "created sets the name, renamed replaces it; a project created in it is a row by id, stamped with the event's time; the same project again is ignored",
      events: [
        created("Booper"),
        projectCreated("prj_1", "monkey"),
        {
          type: "events.iterate.com/organization/renamed",
          payload: { name: "Booper Inc" },
          source: platform,
        },
        projectCreated("prj_1", "monkey"),
        projectCreated("prj_2", "voice"),
      ],
      state: {
        name: "Booper Inc",
        deletedAt: null,
        members: {},
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
          type: "events.iterate.com/organization/project-created",
          payload: { projectId: "x" },
          source: platform,
        },
        created("Booper"),
      ],
      state: { name: "Booper", deletedAt: null, members: {}, projects: {}, secrets: {} },
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
          type: "events.iterate.com/organization/project-created",
          payload: { projectId: "prj_f", slug: "forged" },
        },
      ],
      state: { name: "Booper", deletedAt: null, members: {}, projects: {}, secrets: {} },
    },
  ];
  for (const { name, events, state } of rows)
    test(name, () => expect(reduceProcessor(new OrganizationProcessor(), events)).toEqual(state));
});
