// src/organization/processor.test.ts — the OrganizationProcessor's executable spec: declarative
// `{ events → state }` rows on the shared processor harness (stream/test-support.ts
// `reduceProcessor`): the pure reduce, with the engine's contract validation (a malformed KNOWN
// payload is skipped).
import { describe, expect, test } from "vitest";
import { reduceProcessor } from "../stream/test-support.ts";
import { OrganizationProcessor } from "./processor.ts";
import { type OrganizationState } from "./contract.ts";

const created = (name: string) => ({
  type: "events.iterate.com/organization/created",
  payload: { name },
});
const projectCreated = (projectId: string, slug: string) => ({
  type: "events.iterate.com/organization/project-created",
  payload: { projectId, slug },
});

describe("OrganizationProcessor — the organization's record folded from facts", () => {
  const rows: {
    name: string;
    events: { type: string; payload?: unknown }[];
    state: OrganizationState;
  }[] = [
    {
      name: "the empty record",
      events: [],
      state: { name: null, deletedAt: null, projects: {}, secrets: {} },
    },
    {
      name: "created sets the name, renamed replaces it; a project created in it is a row by id, stamped with the event's time; the same project again is ignored",
      events: [
        created("Booper"),
        projectCreated("prj_1", "monkey"),
        { type: "events.iterate.com/organization/renamed", payload: { name: "Booper Inc" } },
        projectCreated("prj_1", "monkey"),
        projectCreated("prj_2", "voice"),
      ],
      state: {
        name: "Booper Inc",
        deletedAt: null,
        projects: {
          prj_1: { slug: "monkey", createdAt: expect.any(String) },
          prj_2: { slug: "voice", createdAt: expect.any(String) },
        },
        secrets: {},
      },
    },
    {
      name: "deleted stamps the record once and keeps it; an unrelated event leaves the state as it was",
      events: [
        created("Booper"),
        { type: "note", payload: { n: 1 } },
        { type: "events.iterate.com/organization/deleted", payload: {} },
        { type: "events.iterate.com/organization/deleted", payload: {} },
      ],
      state: { name: "Booper", deletedAt: expect.any(String), projects: {}, secrets: {} },
    },
    {
      name: "a malformed payload for a KNOWN type is skipped by the contract, never reduced",
      events: [
        { type: "events.iterate.com/organization/created", payload: { name: "" } },
        { type: "events.iterate.com/organization/project-created", payload: { projectId: "x" } },
        created("Booper"),
      ],
      state: { name: "Booper", deletedAt: null, projects: {}, secrets: {} },
    },
  ];
  for (const { name, events, state } of rows)
    test(name, () => expect(reduceProcessor(new OrganizationProcessor(), events)).toEqual(state));
});
