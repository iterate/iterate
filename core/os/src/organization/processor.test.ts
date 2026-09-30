// src/organization/processor.test.ts — the OrganizationProcessor's executable spec: declarative
// `{ events → state }` rows on the shared processor harness (iterate/stream/test-support
// `reduceProcessor`): the pure reduce, with the engine's contract validation.
import { expect, test } from "vitest";
import { reduceProcessor } from "iterate/stream/test-support";
import { OrganizationProcessor } from "./processor.ts";
import { type OrganizationState } from "./contract.ts";

/** A certificate the organization folds is the platform's cross-post: stamped `source.platform`. */
const platform = { platform: true } as const;

test.for<{
  name: string;
  events: { type: string; payload?: unknown; source?: typeof platform }[];
  state: OrganizationState;
}>([
  { name: "the empty record", events: [], state: { secrets: {} } },
  {
    name: "the organization's activity folds into nothing: its record is the control-plane database's",
    events: [
      {
        type: "events.iterate.com/organization/created",
        payload: { name: "Booper" },
        source: platform,
      },
      {
        type: "events.iterate.com/organization/member-added",
        payload: { orgId: "org_1", userId: "user_1", role: "owner" },
        source: platform,
      },
      {
        type: "events.iterate.com/organization/project-added",
        payload: { projectId: "prj_1", slug: "monkey" },
        source: platform,
      },
    ],
    state: { secrets: {} },
  },
  {
    name: "a secret the platform cross-posted is a row by path, deleted drops it; one a member appended changes nothing",
    events: [
      secretSet("/secrets/stripe", platform),
      secretSet("/secrets/openai", platform),
      {
        type: "events.iterate.com/secret/deleted",
        payload: { path: "/secrets/openai" },
        source: platform,
      },
      secretSet("/secrets/forged"),
    ],
    state: {
      secrets: {
        "/secrets/stripe": { urls: ["https://api.example.test"], createdAt: expect.any(String) },
      },
    },
  },
])(
  "OrganizationProcessor — the organization's state folded from facts: $name",
  ({ events, state }) => {
    expect(reduceProcessor(new OrganizationProcessor(), events)).toEqual(state);
  },
);

function secretSet(path: string, source?: typeof platform) {
  return {
    type: "events.iterate.com/secret/set",
    payload: { path, urls: ["https://api.example.test"] },
    source,
  };
}
