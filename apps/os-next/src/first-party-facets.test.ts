// src/first-party-facets.test.ts — the reduce reads a first-party facet's hosting target WITHOUT a
// spec: `itx.builtins.facets.get("repo").processEventBatch` marks the row as hosting RepoDurableObject
// (this worker's class), while any other name still needs `{ source, className }` to host.
import { expect, test } from "vitest";
import type { ItxExpression } from "iterate/next/expression";
import { facetSpecFromHostingTarget } from "./stream/core-processor.ts";
import { FIRST_PARTY_FACET_CLASSES, firstPartyFacetClassOf } from "./first-party-facets.ts";

const target = (getStep: unknown[]): ItxExpression =>
  ["itx", "builtins", "facets", getStep, "processEventBatch"] as unknown as ItxExpression;

test("a first-party name hosts its exported class with no source; other names need a spec", () => {
  for (const [name, className] of Object.entries(FIRST_PARTY_FACET_CLASSES)) {
    expect(firstPartyFacetClassOf(name)).toBe(className);
    expect(facetSpecFromHostingTarget(target(["get", name]))).toEqual({ name, className });
  }
  expect(firstPartyFacetClassOf("presence")).toBeUndefined();
  expect(facetSpecFromHostingTarget(target(["get", "presence"]))).toBeUndefined();
  expect(
    facetSpecFromHostingTarget(
      target(["get", "presence", { source: { "cap.js": "export {}" }, className: "P" }]),
    ),
  ).toEqual({ name: "presence", source: { "cap.js": "export {}" }, className: "P" });
});
