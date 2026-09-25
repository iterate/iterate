// src/fetch-routes.test.ts — the route table's executable spec: the fold as declarative
// `{ events → table }` rows, and the match as `{ routes, request → route name }` rows. The table in
// core state (the append boundary, the reduce) is pinned in stream/core-processor.test.ts; the
// verbs — `itx.fetchRoutes.set` landing the fact, a config worker forwarding a match to a lent
// stub, a WebSocket with its subprotocol — in __workers-tests__/fetch-routes.test.ts.

import { expect, test } from "vitest";
import {
  matchFetchRoute,
  reduceFetchRouteConfigured,
  type FetchRouteTable,
} from "./fetch-routes.ts";

const blog = {
  fetchRouteName: "tunnel-blog",
  requestMatcher: { routingSlug: "blog" },
  target: ["itx", "tunnels", "blog"],
  authRequirement: { visitors: "project-members" },
};
const blogPublic = {
  fetchRouteName: "tunnel-blog",
  requestMatcher: { routingSlug: "blog" },
  target: ["itx", "tunnels", "blog"],
  authRequirement: null,
  priority: 5,
};
const blogDeleted = { fetchRouteName: "tunnel-blog", requestMatcher: null };

test.for<{ name: string; facts: unknown[]; table: FetchRouteTable }>([
  { name: "the empty table", facts: [], table: {} },
  {
    name: "a route is set at its offset; priority defaults to 0, authRequirement to null when absent",
    facts: [{ fetchRouteName: "api", requestMatcher: {}, target: ["itx", "api"] }],
    table: {
      api: {
        requestMatcher: {},
        target: ["itx", "api"],
        authRequirement: null,
        priority: 0,
        configuredOffset: 1,
      },
    },
  },
  {
    name: "the latest fact is the route (a private tunnel made public, reprioritized)",
    facts: [blog, blogPublic],
    table: {
      "tunnel-blog": {
        requestMatcher: { routingSlug: "blog" },
        target: ["itx", "tunnels", "blog"],
        authRequirement: null,
        priority: 5,
        configuredOffset: 2,
      },
    },
  },
  {
    name: "a null requestMatcher deletes the route; deleting a route that is gone is a harmless fact",
    facts: [blog, blogDeleted, blogDeleted],
    table: {},
  },
  {
    name: "a name that is a key of Object.prototype is a route like any other: no route until one is set",
    facts: [
      { fetchRouteName: "constructor", requestMatcher: null },
      { fetchRouteName: "constructor", requestMatcher: {}, target: ["itx", "x"] },
    ],
    table: {
      constructor: {
        requestMatcher: {},
        target: ["itx", "x"],
        authRequirement: null,
        priority: 0,
        configuredOffset: 2,
      },
    },
  },
  {
    name: "a malformed payload is skipped: a bad name, a matcher without a target, an unknown matcher field, a bad URLPattern, none at all",
    facts: [
      { fetchRouteName: "Not A Label", requestMatcher: {}, target: ["itx", "x"] },
      { fetchRouteName: "no-target", requestMatcher: {} },
      { fetchRouteName: "bad", requestMatcher: { method: "GET" }, target: ["itx", "x"] },
      {
        fetchRouteName: "bad-url",
        requestMatcher: { url: { pathname: "(" } },
        target: ["itx", "x"],
      },
      undefined,
    ],
    table: {},
  },
])("reduceFetchRouteConfigured: $name", ({ facts, table }) => {
  expect(tableOf(facts)).toEqual(table);
});

test("reduceFetchRouteConfigured: a fact that changes nothing answers undefined (the core reduce's keep-the-state signal); one that changes answers a new table and leaves the given one as it was", () => {
  const table = tableOf([blog]);
  const before = structuredClone(table);
  expect(reduceFetchRouteConfigured(table, { offset: 9, payload: blogDeleted })).toEqual({});
  expect(reduceFetchRouteConfigured(table, { offset: 9, payload: blogPublic })).toMatchObject({
    "tunnel-blog": { priority: 5, configuredOffset: 9 },
  });
  expect(table).toEqual(before);
  expect(reduceFetchRouteConfigured({}, { offset: 9, payload: blogDeleted })).toBeUndefined();
  expect(
    reduceFetchRouteConfigured(table, { offset: 9, payload: { nonsense: true } }),
  ).toBeUndefined();
});

/** The table the match rows read: a route per matcher kind, two tied on priority. */
const table = tableOf([
  {
    fetchRouteName: "tunnel-blog",
    requestMatcher: { routingSlug: "blog" },
    target: ["itx", "tunnels", "blog"],
  },
  {
    fetchRouteName: "api-v2",
    requestMatcher: { url: { pathname: "/api/v2/*" } },
    target: ["itx", "apiV2"],
    priority: 10,
  },
  {
    fetchRouteName: "docs-host",
    requestMatcher: { url: { hostname: "docs.example.com" } },
    target: ["itx", "docs"],
  },
  {
    fetchRouteName: "canary",
    requestMatcher: { headers: { "X-Canary": "1" } },
    target: ["itx", "canary"],
  },
  { fetchRouteName: "b-catch-all", requestMatcher: {}, target: ["itx", "b"], priority: -1 },
  { fetchRouteName: "a-catch-all", requestMatcher: {}, target: ["itx", "a"], priority: -1 },
]);

test.for<{ name: string; url: string; headers: Record<string, string>; fetchRouteName: string }>([
  {
    name: "the routing slug the edge stamped",
    url: "https://blog--acme.iterate.app/",
    headers: { "x-iterate-routing-slug": "blog" },
    fetchRouteName: "tunnel-blog",
  },
  {
    name: "the apex has no routing slug, so a slug route never takes it",
    url: "https://acme.iterate.app/",
    headers: {},
    fetchRouteName: "a-catch-all",
  },
  {
    name: "a URLPattern pathname, and the higher priority wins over the slug route",
    url: "https://blog--acme.iterate.app/api/v2/pets?id=1",
    headers: { "x-iterate-routing-slug": "blog" },
    fetchRouteName: "api-v2",
  },
  {
    name: "a pathname the pattern does not cover falls through",
    url: "https://acme.iterate.app/api/v1/pets",
    headers: {},
    fetchRouteName: "a-catch-all",
  },
  {
    name: "a URLPattern hostname (a custom domain)",
    url: "https://docs.example.com/guide",
    headers: {},
    fetchRouteName: "docs-host",
  },
  {
    name: "a header, its name case-insensitive, its value exact",
    url: "https://acme.iterate.app/",
    headers: { "x-canary": "1" },
    fetchRouteName: "canary",
  },
  {
    name: "a header value that differs does not match",
    url: "https://acme.iterate.app/",
    headers: { "x-canary": "yes" },
    fetchRouteName: "a-catch-all",
  },
  {
    name: "tied on priority, the name decides",
    url: "https://other--acme.iterate.app/",
    headers: { "x-iterate-routing-slug": "other" },
    fetchRouteName: "a-catch-all",
  },
])("matchFetchRoute: $name", ({ url, headers, fetchRouteName }) => {
  expect(matchFetchRoute(table, { url, headers: new Headers(headers) })).toMatchObject({
    fetchRouteName,
  });
});

test("matchFetchRoute: an empty table, or no route whose matcher holds, is null", () => {
  expect(
    matchFetchRoute({}, { url: "https://acme.iterate.app/", headers: new Headers() }),
  ).toBeNull();
  const { "a-catch-all": _a, "b-catch-all": _b, ...withoutCatchAll } = table;
  expect(
    matchFetchRoute(withoutCatchAll, {
      url: "https://acme.iterate.app/",
      headers: new Headers(),
    }),
  ).toBeNull();
});

/** The table the `configured` facts with these payloads fold to, the first at offset 1. */
function tableOf(payloads: unknown[]): FetchRouteTable {
  return payloads.reduce<FetchRouteTable>(
    (table, payload, i) => reduceFetchRouteConfigured(table, { offset: i + 1, payload }) ?? table,
    {},
  );
}
