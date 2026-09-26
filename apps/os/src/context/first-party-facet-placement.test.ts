// context/first-party-facet-placement.test.ts — every rule of first-party-facet-placement.ts as table
// rows: the facet (or a stateless worker), the context written `<projectId>:<path>`, and whether it
// may be hosted there. The refusal end to end, through a person who signed in, is
// __workers-tests__/facets.test.ts.
import { expect, test } from "vitest";
import { errorCode } from "iterate/lib";
import { FIRST_PARTY_FACET_CLASSES } from "../first-party-facets.ts";
import { assertFacetPlacement, assertLoadedCodePlacement } from "./first-party-facet-placement.ts";

const FIRST_PARTY_FACET_PLACEMENT_ROWS = [
  // 1. `account` — a user's own context, and nowhere else.
  { facet: "account", context: "global:/users/user_1", allowed: true },
  { facet: "account", context: "global:/users/user_1/notes", allowed: false },
  { facet: "account", context: "global:/users/user_1/secrets/api-key", allowed: false },
  { facet: "account", context: "global:/users", allowed: false },
  { facet: "account", context: "global:/organizations/org_1", allowed: false },
  { facet: "account", context: "global:/", allowed: false },
  { facet: "account", context: "prj_1:/", allowed: false },
  { facet: "account", context: "prj_1:/users/user_1", allowed: false },
  // 2. `organization` — an organization's own context, and nowhere else.
  { facet: "organization", context: "global:/organizations/org_1", allowed: true },
  { facet: "organization", context: "global:/organizations/org_1/secrets/api-key", allowed: false },
  { facet: "organization", context: "global:/organizations", allowed: false },
  { facet: "organization", context: "global:/users/user_1", allowed: false },
  { facet: "organization", context: "global:/", allowed: false },
  { facet: "organization", context: "prj_1:/", allowed: false },
  { facet: "organization", context: "prj_1:/organizations/org_1", allowed: false },
  // 3. `project` — a project's root, and nowhere else.
  { facet: "project", context: "prj_1:/", allowed: true },
  { facet: "project", context: "prj_1:/notes", allowed: false },
  { facet: "project", context: "prj_1:/secrets/api-key", allowed: false },
  { facet: "project", context: "prj_1:/repos/config", allowed: false },
  { facet: "project", context: "global:/", allowed: false },
  { facet: "project", context: "global:/users/user_1", allowed: false },
  { facet: "project", context: "global:/organizations/org_1", allowed: false },
  { facet: "project", context: "global:/projects/prj_1", allowed: false },
  // 4. `secret` — `/secrets/<name>` directly under its owner's root, the global root's included.
  { facet: "secret", context: "prj_1:/secrets/api-key", allowed: true },
  { facet: "secret", context: "prj_1:/secrets/a.b_c-1", allowed: true },
  { facet: "secret", context: "prj_1:/secrets/...", allowed: true },
  { facet: "secret", context: "global:/users/user_1/secrets/api-key", allowed: true },
  { facet: "secret", context: "global:/organizations/org_1/secrets/api-key", allowed: true },
  { facet: "secret", context: "prj_1:/", allowed: false },
  { facet: "secret", context: "prj_1:/secrets", allowed: false },
  { facet: "secret", context: "prj_1:/notes", allowed: false },
  { facet: "secret", context: "prj_1:/repos/config", allowed: false },
  { facet: "secret", context: "prj_1:/app/secrets/api-key", allowed: false },
  { facet: "secret", context: "prj_1:/secrets/api-key/more", allowed: false },
  { facet: "secret", context: "global:/users/user_1", allowed: false },
  { facet: "secret", context: "global:/users/user_1/notes/secrets/api-key", allowed: false },
  { facet: "secret", context: "global:/organizations/org_1", allowed: false },
  { facet: "secret", context: "global:/secrets/api-key", allowed: true },
  { facet: "secret", context: "global:/secrets", allowed: false },
  { facet: "secret", context: "global:/notes/secrets/api-key", allowed: false },
  { facet: "secret", context: "global:/", allowed: false },
  // 5. `repo`, `workspace` — any context of a project; never the global namespace.
  { facet: "repo", context: "prj_1:/repos/config", allowed: true },
  { facet: "repo", context: "prj_1:/", allowed: true },
  { facet: "repo", context: "prj_1:/deep/path", allowed: true },
  { facet: "repo", context: "global:/users/user_1", allowed: false },
  { facet: "repo", context: "global:/organizations/org_1", allowed: false },
  { facet: "repo", context: "global:/", allowed: false },
  { facet: "workspace", context: "prj_1:/workspaces/four", allowed: true },
  { facet: "workspace", context: "prj_1:/", allowed: true },
  { facet: "workspace", context: "global:/users/user_1", allowed: false },
  { facet: "workspace", context: "global:/organizations/org_1", allowed: false },
  { facet: "workspace", context: "global:/", allowed: false },
  // 6. Loaded code — any other facet name — runs inside a project, never in the global namespace.
  { facet: "presence", context: "prj_1:/", allowed: true },
  { facet: "agents", context: "prj_1:/agents", allowed: true },
  { facet: "tally", context: "prj_1:/deep/path", allowed: true },
  { facet: "presence", context: "global:/users/user_1", allowed: false },
  { facet: "tally", context: "global:/users/user_1/secrets/api-key", allowed: false },
  { facet: "tally", context: "global:/organizations/org_1", allowed: false },
  { facet: "tally", context: "global:/", allowed: false },
  { facet: "toString", context: "global:/", allowed: false },
  // 7. `instance` — the global root, and nowhere else.
  { facet: "instance", context: "global:/", allowed: true },
  { facet: "instance", context: "global:/secrets/api-key", allowed: false },
  { facet: "instance", context: "global:/users/user_1", allowed: false },
  { facet: "instance", context: "prj_1:/", allowed: false },
];

/** 6., the stateless worker (`itx.workers.get({ source })`, and `itx.run`'s script through it). */
const LOADED_WORKER_PLACEMENT_ROWS = [
  { context: "prj_1:/", allowed: true },
  { context: "prj_1:/agents/sandbox", allowed: true },
  { context: "global:/users/user_1", allowed: false },
  { context: "global:/organizations/org_1", allowed: false },
  { context: "global:/", allowed: false },
];

test.for(FIRST_PARTY_FACET_PLACEMENT_ROWS)(
  "facet $facet on $context: allowed $allowed",
  ({ facet, context, allowed }) => {
    expect(refusalOf(() => assertFacetPlacement(facet, contextAddress(context)))).toBe(
      allowed ? undefined : "FORBIDDEN",
    );
  },
);

test.for(LOADED_WORKER_PLACEMENT_ROWS)(
  "a loaded worker on $context: allowed $allowed",
  ({ context, allowed }) => {
    expect(refusalOf(() => assertLoadedCodePlacement("workers.get", contextAddress(context)))).toBe(
      allowed ? undefined : "FORBIDDEN",
    );
  },
);

test("every first-party facet has a row where it may be hosted", () => {
  const placed = FIRST_PARTY_FACET_PLACEMENT_ROWS.filter((row) => row.allowed).map(
    (row) => row.facet,
  );
  for (const facet of Object.keys(FIRST_PARTY_FACET_CLASSES)) expect(placed).toContain(facet);
});

test("each refusal names what was refused, where it belongs, and the context", () => {
  expect(() =>
    assertFacetPlacement("project", { projectId: "global", path: "/users/user_1" }),
  ).toThrow(
    `facet "project" is first-party and is hosted only on a project's root, "/" — never on global:/users/user_1`,
  );
  expect(() =>
    assertFacetPlacement("tally", { projectId: "global", path: "/users/user_1" }),
  ).toThrow(
    `facet "tally": loaded code runs only in a project — never in the global namespace (global:/users/user_1)`,
  );
});

/** The refusal's code, or undefined when `assert` passed. */
function refusalOf(assert: () => void): string | undefined {
  try {
    assert();
    return undefined;
  } catch (error) {
    return errorCode(error) ?? String(error);
  }
}

/** `<projectId>:<path>` as the address the rules read. */
function contextAddress(context: string) {
  const separator = context.indexOf(":");
  return { projectId: context.slice(0, separator), path: context.slice(separator + 1) };
}
