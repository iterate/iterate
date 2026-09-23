// __workers-tests__/facet-public-methods.test.ts — A CALLER REACHES WHAT A FACET'S CLASS LISTS, AND
// NOTHING ELSE. Every rule of src/context/facet-public-methods.ts as table rows, end to end: a person
// signed in with the login form calls one method BY ITX EXPRESSION on a facet of a context they hold,
// and the row says whether the call reaches the facet or is refused FORBIDDEN because the facet's
// class does not list it. A call that reaches the facet may still fail there (a repo never created,
// a method called without its arguments) — that is the facet's answer, not the list's. The
// behavioural consequences — a forged batch changes nothing, a direct secret write leaves the value
// alone — are __workers-tests__/forged-facet-inputs.test.ts.

import { expect, test } from "vitest";
import { errorCode } from "iterate/next/lib";
import { signedInSession } from "./support.ts";

/** A person's own processor with a method of its own (`hello`), loaded from source. */
const LOADED_PROCESSOR_SOURCE = {
  "cap.js": /* js */ `
import { StreamProcessor, StreamProcessorDurableObject, defineProcessorContract, z } from "./processor.js";
const contract = defineProcessorContract({
  slug: "tally",
  version: "1.0.0",
  description: "counts every event on its context's log",
  stateSchema: z.object({ n: z.number().default(0) }),
  consumes: ["*"],
  emits: [],
});
class TallyProcessor extends StreamProcessor {
  contract = contract;
  reduce({ state }) { return { n: state.n + 1 }; }
}
export class TallyDurableObject extends StreamProcessorDurableObject {
  static publicMethods = [...super.publicMethods, "hello"];
  processor = new TallyProcessor();
  hello() { return "hello from a loaded processor"; }
}
`,
};

/** A loaded class that extends neither SDK facet shell: it lists nothing. */
const PLAIN_DURABLE_OBJECT_SPEC = {
  source: {
    "cap.js": /* js */ `
import { DurableObject } from "cloudflare:workers";
export class Plain extends DurableObject {
  hello() { return "hello from a plain Durable Object"; }
  fetch() { return new Response("plain"); }
}
`,
  },
  className: "Plain",
};

/** One row: the facet (on the context the platform hosts it on), a method called on it by itx
 *  expression, and what comes of it. `loaded processor` is `LOADED_PROCESSOR_SOURCE` enabled at
 *  `/tally`; `plain Durable Object` is `PLAIN_DURABLE_OBJECT_SPEC` at `/plain`. */
type FacetPublicMethodRow = {
  facet:
    | "account"
    | "organization"
    | "project"
    | "repo"
    | "workspace"
    | "secret"
    | "loaded processor"
    | "plain Durable Object";
  method: string;
  byExpression: "reaches the facet" | "FORBIDDEN";
};

const FACET_PUBLIC_METHOD_ROWS: FacetPublicMethodRow[] = [
  // 1–2. What a class lists reaches the facet: the processor reads every processor lists, and a
  // class's own methods on top.
  { facet: "account", method: "snapshot", byExpression: "reaches the facet" },
  { facet: "account", method: "liveSnapshot", byExpression: "reaches the facet" },
  { facet: "account", method: "waitUntilProcessed", byExpression: "reaches the facet" },
  { facet: "account", method: "fetch", byExpression: "reaches the facet" },
  { facet: "organization", method: "snapshot", byExpression: "reaches the facet" },
  { facet: "project", method: "snapshot", byExpression: "reaches the facet" },
  { facet: "project", method: "repos", byExpression: "reaches the facet" },
  { facet: "project", method: "workspaces", byExpression: "reaches the facet" },
  { facet: "repo", method: "readFile", byExpression: "reaches the facet" },
  { facet: "repo", method: "commitFiles", byExpression: "reaches the facet" },
  { facet: "workspace", method: "readFile", byExpression: "reaches the facet" },
  { facet: "workspace", method: "gitStatus", byExpression: "reaches the facet" },
  { facet: "secret", method: "snapshot", byExpression: "reaches the facet" },
  { facet: "loaded processor", method: "snapshot", byExpression: "reaches the facet" },
  { facet: "loaded processor", method: "hello", byExpression: "reaches the facet" },
  // 1, 3. What feeds a facet is on no list — first-party and loaded alike.
  { facet: "account", method: "processEventBatch", byExpression: "FORBIDDEN" },
  { facet: "account", method: "catchUpFromLog", byExpression: "FORBIDDEN" },
  { facet: "account", method: "revive", byExpression: "FORBIDDEN" },
  { facet: "organization", method: "processEventBatch", byExpression: "FORBIDDEN" },
  { facet: "project", method: "processEventBatch", byExpression: "FORBIDDEN" },
  { facet: "project", method: "catchUpFromLog", byExpression: "FORBIDDEN" },
  { facet: "repo", method: "processEventBatch", byExpression: "FORBIDDEN" },
  { facet: "workspace", method: "revive", byExpression: "FORBIDDEN" },
  { facet: "loaded processor", method: "processEventBatch", byExpression: "FORBIDDEN" },
  { facet: "loaded processor", method: "catchUpFromLog", byExpression: "FORBIDDEN" },
  { facet: "loaded processor", method: "revive", byExpression: "FORBIDDEN" },
  // 1. Nor is what a class has but never listed: the SDK's own plumbing.
  { facet: "account", method: "listPublicMethods", byExpression: "FORBIDDEN" },
  { facet: "account", method: "withItx", byExpression: "FORBIDDEN" },
  { facet: "loaded processor", method: "publishLiveState", byExpression: "FORBIDDEN" },
  // 3. The `secret` facet lists its reads alone.
  { facet: "secret", method: "write", byExpression: "FORBIDDEN" },
  { facet: "secret", method: "clear", byExpression: "FORBIDDEN" },
  { facet: "secret", method: "beginOAuth", byExpression: "FORBIDDEN" },
  { facet: "secret", method: "completeOAuth", byExpression: "FORBIDDEN" },
  { facet: "secret", method: "verifyHmac", byExpression: "FORBIDDEN" },
  { facet: "secret", method: "fetch", byExpression: "FORBIDDEN" },
  { facet: "secret", method: "exportForProjectSeed", byExpression: "FORBIDDEN" },
  { facet: "secret", method: "processEventBatch", byExpression: "FORBIDDEN" },
  // 4. A loaded class that extends neither shell lists nothing.
  { facet: "plain Durable Object", method: "hello", byExpression: "FORBIDDEN" },
  { facet: "plain Durable Object", method: "fetch", byExpression: "FORBIDDEN" },
];

/** What a call by expression came to: refused by the list, or anything else — an answer, or the
 *  facet's own failure. */
async function byExpression(call: () => Promise<unknown>): Promise<string> {
  try {
    await call();
    return "reaches the facet";
  } catch (error) {
    const refusedByTheList =
      errorCode(error) === "FORBIDDEN" &&
      /is not one of its public methods/.test(error instanceof Error ? error.message : "");
    return refusedByTheList ? "FORBIDDEN" : "reaches the facet";
  }
}

test("a signed-in person calls each facet by itx expression: what its class lists reaches the facet, and everything else is refused FORBIDDEN", async () => {
  const session = await signedInSession("facet-public-methods@example.com");
  const organization = (await session.organizations.create({ name: "public methods org" })) as {
    id: string;
  };
  const project = await session.projects.create({
    project: "facet-public-methods",
    orgId: organization.id,
  });
  await project
    .cd("/tally")
    .invoke([
      "itx",
      "processors",
      ["enable", "tally", { source: LOADED_PROCESSOR_SOURCE, className: "TallyDurableObject" }],
    ]);
  const facetCall = (facet: FacetPublicMethodRow["facet"], method: string) => {
    const call = [method];
    if (facet === "account") return session.user.invoke(["itx", "facets", ["get", facet], call]);
    if (facet === "organization")
      return session.organizations
        .get(organization.id)
        .invoke(["itx", "facets", ["get", facet], call]);
    if (facet === "loaded processor")
      return project.cd("/tally").invoke(["itx", "facets", ["get", "tally"], call]);
    if (facet === "plain Durable Object")
      return project
        .cd("/plain")
        .invoke(["itx", "facets", ["get", "plain", PLAIN_DURABLE_OBJECT_SPEC], call]);
    const path = {
      project: "/",
      repo: "/repos/notes",
      workspace: "/workspaces/notes",
      secret: "/secrets/api-key",
    }[facet];
    return project.cd(path).invoke(["itx", "facets", ["get", facet], call]);
  };
  const outcomes = [];
  for (const row of FACET_PUBLIC_METHOD_ROWS)
    outcomes.push({
      ...row,
      byExpression: await byExpression(() => facetCall(row.facet, row.method)),
    });
  expect(outcomes).toEqual(FACET_PUBLIC_METHOD_ROWS);
});
