// The backfill's fold of an organization's activity log into the dates of its rows. The D1 reads and
// writes and the log reads are the script's IO, run against a preview (the PR says how).
import { expect, test } from "vitest";
import { activityDates } from "./backfill-created-at.ts";

test.for([
  {
    name: "an organization, its owner and its project are dated by their facts",
    events: [
      fact("events.iterate.com/organization/created", "12:00", { name: "Acme" }),
      fact("events.iterate.com/organization/member-added", "12:01", member("usr_a", "owner")),
      fact("events.iterate.com/organization/project-added", "12:02", project("prj_1")),
    ],
    expected: {
      organization: "12:00",
      memberships: { usr_a: "12:01" },
      projects: { prj_1: "12:02" },
    },
  },
  {
    name: "a change of role keeps the date of the add that began the membership",
    events: [
      fact("events.iterate.com/organization/member-added", "12:01", member("usr_b", "member")),
      fact("events.iterate.com/organization/member-added", "12:05", member("usr_b", "owner")),
    ],
    expected: { memberships: { usr_b: "12:01" }, projects: {} },
  },
  {
    name: "a member who left and rejoined is dated by the rejoin, and one who left by nothing",
    events: [
      fact("events.iterate.com/organization/member-added", "12:01", member("usr_b", "member")),
      fact("events.iterate.com/organization/member-added", "12:02", member("usr_c", "member")),
      fact("events.iterate.com/organization/member-removed", "12:03", {
        orgId: "org_1",
        userId: "usr_b",
      }),
      fact("events.iterate.com/organization/member-removed", "12:04", {
        orgId: "org_1",
        userId: "usr_c",
      }),
      fact("events.iterate.com/organization/member-added", "12:05", member("usr_b", "owner")),
    ],
    expected: { memberships: { usr_b: "12:05" }, projects: {} },
  },
  {
    name: "a project removed from the organization is dated by nothing",
    events: [
      fact("events.iterate.com/organization/project-added", "12:01", project("prj_1")),
      fact("events.iterate.com/organization/project-added", "12:02", project("prj_2")),
      fact("events.iterate.com/organization/project-removed", "12:03", project("prj_1")),
    ],
    expected: { memberships: {}, projects: { prj_2: "12:02" } },
  },
  {
    // two facts published close together on a cold context can land out of order
    name: "a member or project whose fact landed before the organization's is dated with it",
    events: [
      fact("events.iterate.com/organization/member-added", "12:00", member("usr_b", "member")),
      fact("events.iterate.com/organization/project-added", "12:00", project("prj_1")),
      fact("events.iterate.com/organization/created", "12:01", { name: "Acme" }),
      fact("events.iterate.com/organization/member-added", "12:01", member("usr_a", "owner")),
    ],
    expected: {
      organization: "12:01",
      memberships: { usr_a: "12:01", usr_b: "12:01" },
      projects: { prj_1: "12:01" },
    },
  },
  {
    // a member can append any type to the organization's context; only the platform stamps it
    name: "a fact a client appended dates nothing",
    events: [
      fact("events.iterate.com/organization/created", "11:00", { name: "Acme" }, {}),
      fact("events.iterate.com/organization/member-added", "11:01", member("usr_x", "owner"), {}),
      fact("events.iterate.com/organization/project-added", "11:02", { projectId: 7 }, {}),
      fact("events.iterate.com/organization/created", "12:00", { name: "Acme" }),
    ],
    expected: { organization: "12:00", memberships: {}, projects: {} },
  },
  {
    name: "every other event on the log is passed over",
    events: [
      fact("events.iterate.com/itx/woken", "12:00", {}),
      fact("events.iterate.com/organization/invitation-accepted", "12:01", {
        invitationId: "inv_1",
        userId: "usr_d",
      }),
      fact("events.iterate.com/secret/set", "12:02", { name: "API_KEY" }),
    ],
    expected: { memberships: {}, projects: {} },
  },
])("$name", ({ events, expected }) => {
  const { organization, memberships, projects } = activityDates(events);
  const clock = (at: number) => new Date(at).toISOString().slice(11, 16);
  // exact (toEqual passes over an undefined `organization`): a row dated that should stay null is
  // what this guards against
  expect({
    organization: organization && clock(organization),
    memberships: Object.fromEntries([...memberships].map(([id, at]) => [id, clock(at)])),
    projects: Object.fromEntries([...projects].map(([id, at]) => [id, clock(at)])),
  }).toEqual(expected);
});

/** A committed event on the organization's log at `clock` (HH:MM) on 2026-09-20, the platform's
 *  unless `source` says otherwise. */
function fact(
  type: string,
  clock: string,
  payload: Record<string, unknown>,
  source: Record<string, unknown> = { platform: true },
) {
  return { type, payload, source, createdAt: `2026-09-20T${clock}:00.000Z`, offset: 1, path: "/" };
}

function member(userId: string, role: "owner" | "member") {
  return { orgId: "org_1", userId, role };
}

function project(projectId: string) {
  return { projectId, slug: projectId.replace("_", "-") };
}
