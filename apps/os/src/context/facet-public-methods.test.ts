// context/facet-public-methods.test.ts — the rules of facet-public-methods.ts as table rows over the
// classes' own lists: a facet class, a walk a caller spells on it (relative to the facet), and
// whether the walk reaches the facet or is refused FORBIDDEN. The same rules end to end, through a
// person who signed in, are __workers-tests__/facet-public-methods.test.ts.
import { expect, test } from "vitest";
import { parse } from "iterate/next/expression";
import { errorCode } from "iterate/next/lib";
import { FacetDurableObject, StreamProcessorDurableObject } from "iterate/next/sdk";
import { AccountDurableObject } from "../account/durable-object.ts";
import { ProjectDurableObject } from "../project/durable-object.ts";
import { SecretDurableObject } from "../secret/durable-object.ts";
import { assertFacetMethodIsPublic } from "./facet-public-methods.ts";

const FACET_PUBLIC_METHOD_ROWS: {
  facet: keyof typeof FACET_CLASSES;
  walk: string;
  byExpression: "reaches the facet" | "FORBIDDEN";
}[] = [
  // 1. The FIRST step decides — a call, a property read, or the head of a longer walk.
  { facet: "account", walk: "snapshot()", byExpression: "reaches the facet" },
  { facet: "account", walk: "snapshot", byExpression: "reaches the facet" },
  { facet: "project", walk: "repos().create('/repos/x')", byExpression: "reaches the facet" },
  {
    facet: "account",
    walk: "processEventBatch([], { after: 0, through: 9 })",
    byExpression: "FORBIDDEN",
  },
  { facet: "account", walk: "processEventBatch", byExpression: "FORBIDDEN" },
  { facet: "account", walk: "revive().then()", byExpression: "FORBIDDEN" },
  // 2. The shells' lists, and a subclass's own on top.
  { facet: "a loaded mini-app", walk: "fetch()", byExpression: "reaches the facet" },
  { facet: "a loaded mini-app", walk: "post('ada', 'hi')", byExpression: "reaches the facet" },
  { facet: "a loaded mini-app", walk: "snapshot()", byExpression: "FORBIDDEN" },
  { facet: "a loaded processor", walk: "liveSnapshot()", byExpression: "reaches the facet" },
  {
    facet: "a loaded processor",
    walk: "waitUntilProcessed({ offset: 1 })",
    byExpression: "reaches the facet",
  },
  { facet: "a loaded processor", walk: "send('hi')", byExpression: "reaches the facet" },
  // 3. What feeds a facet is on no list; the `secret` facet lists its reads alone.
  { facet: "a loaded processor", walk: "catchUpFromLog()", byExpression: "FORBIDDEN" },
  { facet: "a loaded processor", walk: "listPublicMethods()", byExpression: "FORBIDDEN" },
  { facet: "secret", walk: "snapshot()", byExpression: "reaches the facet" },
  { facet: "secret", walk: "write({})", byExpression: "FORBIDDEN" },
  { facet: "secret", walk: "fetch()", byExpression: "FORBIDDEN" },
  { facet: "secret", walk: "verifyHmac({})", byExpression: "FORBIDDEN" },
];

test.each(FACET_PUBLIC_METHOD_ROWS)(
  "$facet: $walk → $byExpression",
  ({ facet, walk, byExpression }) => {
    // The walk as the facet host receives it: the steps after `itx.facets.get(name)`.
    const itxExpressionSteps = parse(`itx.${walk}`).slice(1);
    let outcome = "reaches the facet";
    try {
      assertFacetMethodIsPublic(facet, FACET_CLASSES[facet].publicMethods, itxExpressionSteps);
    } catch (error) {
      outcome = errorCode(error) ?? String(error);
    }
    expect(outcome).toBe(byExpression);
  },
);

test("the refusal names the facet, the step and the list", () => {
  expect(() =>
    assertFacetMethodIsPublic("account", AccountDurableObject.publicMethods, [
      ["processEventBatch"],
    ]),
  ).toThrow(
    `facet "account": "processEventBatch" is not one of its public methods (fetch, snapshot, liveSnapshot, waitUntilProcessed)`,
  );
  expect(() => assertFacetMethodIsPublic("plain", [], [["hello"]])).toThrow(
    `facet "plain": "hello" is not one of its public methods (it lists none)`,
  );
});

/** A person's own processor with a verb of its own, as an author spells its list. */
abstract class SendingProcessorDurableObject extends StreamProcessorDurableObject {
  static override publicMethods = [...super.publicMethods, "send"];
}

/** A person's own facet that is no processor — a mini-app with its own state. */
abstract class ChatroomDurableObject extends FacetDurableObject {
  static override publicMethods = [...super.publicMethods, "post", "state"];
}

/** The class each row's facet names; below the classes it lists, read only when a test runs. */
const FACET_CLASSES = {
  account: AccountDurableObject,
  project: ProjectDurableObject,
  secret: SecretDurableObject,
  "a loaded processor": SendingProcessorDurableObject,
  "a loaded mini-app": ChatroomDurableObject,
};
