// context/facet-public-methods.ts — WHAT A CALLER REACHES ON A FACET BY ITX EXPRESSION, pure (no
// I/O). Every walk a caller spells onto a facet — `itx.facets.get(name).<method>(…)`, the same walk
// behind `itx.repos.get(path)` and `itx.workspaces.get(path)` (library.ts), a rule or an app route
// naming a facet — lands in context/facet-host.ts `FacetHost#handle`, the one entry an itx expression
// reaches, which runs the check below. The platform's own calls into a facet — the delivery loop's
// push and catch-up, the alarm's revive, the `itx.secrets` built-ins, egress, the operator's export —
// take the facet host's platform entries, which no walk can land on, and read no list. THE RULES,
// rows of the table tests facet-public-methods.test.ts (beside this file) and
// __workers-tests__/facets.test.ts (end to end, through a person who signed in):
//   1. A facet's class lists what a caller may reach in `static publicMethods`. The walk's FIRST step
//      — the method called on the facet, or the property read off it — must be on that list, or the
//      call is refused FORBIDDEN before it reaches the facet. Later steps walk what that member
//      answered: handing that out is the member's own decision.
//   2. The SDK's facet shells list generously (packages/iterate/src/sdk): `FacetDurableObject`
//      lists `fetch`; `StreamProcessorDurableObject` adds `snapshot`, `liveSnapshot` and
//      `waitUntilProcessed`. A subclass lists its own on top: `[...super.publicMethods, "message"]`.
//   3. What feeds a facet is on no list: `processEventBatch`, `catchUpFromLog` and `revive` are the
//      delivery loop's and the alarm's. The `secret` facet lists its reads alone: its value is
//      written, cleared and exchanged by `itx.secrets` (whose verbs append the attributed facts),
//      verified by `itx.secrets.verifyHmac`, used by egress and exported over the operator's RPC.
//   4. A first-party class's list is read off the class; a loaded class's is asked of the facet once
//      per startup memo (`listPublicMethods()`, which the shells answer). A loaded class that extends
//      neither shell answers no list, so nothing on it is reached by expression.
import { codedError } from "iterate/lib";
import { itxExpressionStepName, type ItxExpression } from "iterate/expression";

/** Refuses — FORBIDDEN — a walk on the facet `facetName` whose first step is not one of the
 *  `publicMethods` its class lists (rule 1). The refusal names the step and the list. */
export function assertFacetMethodIsPublic(
  facetName: string,
  publicMethods: readonly string[],
  itxExpressionSteps: ItxExpression,
): void {
  const method = itxExpressionStepName(itxExpressionSteps[0]) ?? "";
  if (publicMethods.includes(method)) return;
  throw codedError(
    "FORBIDDEN",
    `facet "${facetName}": ${JSON.stringify(method)} is not one of its public methods (${publicMethods.join(", ") || "it lists none"}) — a facet's class lists what a caller reaches by itx expression in static publicMethods`,
  );
}
