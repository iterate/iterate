import { expect, test } from "vitest";
import { CoreContract, normalizeControlEvent, reduceCoreEvent } from "../stream/core-processor.ts";
import { normalizeIngressConfigured } from "./ingress.ts";
import { resolveItxExpression } from "./itx-expression-rewriting.ts";

const target: import("iterate/next/expression").ItxExpression = [
  "itx",
  "workers",
  ["get", { source: { "cap.js": "source" } }],
];
const type = "events.iterate.com/project/ingress-configured";

test("ingress stores and replaces the full expression without creating any rewrite alias", () => {
  const event = {
    ...normalizeControlEvent({ type, payload: { target } }),
    offset: 1,
    path: "/",
    createdAt: "2026-09-21T00:00:00Z",
  };
  const state = reduceCoreEvent({ event, state: CoreContract.initialState() })!;
  expect(state.ingressTarget).toEqual(target);
  expect(state.itxExpressionRewriteRules).toEqual({});
  expect(
    reduceCoreEvent({ event: { ...event, payload: { target: null } }, state })?.ingressTarget,
  ).toBeNull();
  expect(reduceCoreEvent({ event, state })).toBeUndefined();
  expect(
    reduceCoreEvent({ event: { ...event, ephemeral: true }, state: CoreContract.initialState() }),
  ).toBeUndefined();
});

test.each([{}, { target: 123 }, { target: "other.workers" }, { target: ["itx", null] }])(
  "invalid ingress configuration is refused before append: %j",
  (payload) => {
    expect(() => normalizeIngressConfigured(payload)).toThrow();
  },
);

test("ephemeral ingress configuration cannot be published", () => {
  expect(() => normalizeControlEvent({ type, payload: { target }, ephemeral: true })).toThrow(
    "must be durable",
  );
});

test("a singular worker name has no implicit platform resolution", () => {
  expect(() => resolveItxExpression(() => [], ["itx", "worker", "fetch"])).toThrow(
    "no rewrite rule matches",
  );
  expect(resolveItxExpression(() => [], target).at(-1)).toEqual([
    "itx",
    "builtins",
    ...target.slice(1),
  ]);
});
