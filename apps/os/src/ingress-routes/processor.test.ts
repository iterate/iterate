// src/ingress-routes/processor.test.ts — the IngressRoutesProcessor's executable spec: the reduce as
// declarative `{ events → state }` rows (iterate/stream/test-support `reduceProcessor`), and the
// match as `{ routes, request → route name }` rows. The verbs — `itx.ingressRoutes.set` landing the
// fact, a config worker forwarding a match to a lent stub, a WebSocket with its subprotocol — are
// pinned in __workers-tests__/ingress-routes.test.ts.

import { expect, test } from "vitest";
import { reduceProcessor } from "iterate/stream/test-support";
import { IngressRoutesProcessor, matchIngressRoute } from "./processor.ts";
import type { IngressRoutesState } from "./contract.ts";

const blog = configured({
  ingressRouteName: "tunnel-blog",
  requestMatcher: { routingSlug: "blog" },
  target: ["itx", "tunnels", "blog"],
  authRequirement: { visitors: "project-members" },
});
const blogPublic = configured({
  ingressRouteName: "tunnel-blog",
  requestMatcher: { routingSlug: "blog" },
  target: ["itx", "tunnels", "blog"],
  authRequirement: null,
  priority: 5,
});
const blogDeleted = configured({ ingressRouteName: "tunnel-blog", requestMatcher: null });

test.for([
  { name: "the empty state", events: [], state: { ingressRoutes: {} } },
  {
    name: "a route is set at its offset; priority defaults to 0, authRequirement to null when absent",
    events: [
      configured({
        ingressRouteName: "api",
        requestMatcher: {},
        target: ["itx", "api"],
      }),
    ],
    state: {
      ingressRoutes: {
        api: {
          requestMatcher: {},
          target: ["itx", "api"],
          authRequirement: null,
          priority: 0,
          configuredOffset: 1,
        },
      },
    },
  },
  {
    name: "the latest fact is the route (a private tunnel made public, reprioritized)",
    events: [blog, blogPublic],
    state: {
      ingressRoutes: {
        "tunnel-blog": {
          requestMatcher: { routingSlug: "blog" },
          target: ["itx", "tunnels", "blog"],
          authRequirement: null,
          priority: 5,
          configuredOffset: 2,
        },
      },
    },
  },
  {
    name: "a null requestMatcher deletes the route; deleting a route that is gone is a harmless fact",
    events: [blog, blogDeleted, blogDeleted],
    state: { ingressRoutes: {} },
  },
  {
    name: "a malformed payload for the KNOWN type is skipped: a bad name, a matcher without a target, an unknown matcher field, a bad URLPattern",
    events: [
      configured({ ingressRouteName: "Not A Label", requestMatcher: {}, target: ["itx", "x"] }),
      configured({ ingressRouteName: "no-target", requestMatcher: {} }),
      configured({
        ingressRouteName: "bad",
        requestMatcher: { method: "GET" },
        target: ["itx", "x"],
      }),
      configured({
        ingressRouteName: "bad-url",
        requestMatcher: { url: { pathname: "(" } },
        target: ["itx", "x"],
      }),
    ],
    state: { ingressRoutes: {} },
  },
  {
    name: "an unrelated event leaves the table as it was",
    events: [blog, { type: "note" }],
    state: {
      ingressRoutes: {
        "tunnel-blog": {
          requestMatcher: { routingSlug: "blog" },
          target: ["itx", "tunnels", "blog"],
          authRequirement: { visitors: "project-members" },
          priority: 0,
          configuredOffset: 1,
        },
      },
    },
  },
] satisfies {
  name: string;
  events: { type: string; payload?: unknown }[];
  state: IngressRoutesState;
}[])("IngressRoutesProcessor — the reduce: $name", ({ events, state }) => {
  expect(reduceProcessor(new IngressRoutesProcessor(), events)).toEqual(state);
});

/** The table the match rows read: a route per matcher kind, two tied on priority. */
const table = reduceProcessor(new IngressRoutesProcessor(), [
  configured({
    ingressRouteName: "tunnel-blog",
    requestMatcher: { routingSlug: "blog" },
    target: ["itx", "tunnels", "blog"],
  }),
  configured({
    ingressRouteName: "api-v2",
    requestMatcher: { url: { pathname: "/api/v2/*" } },
    target: ["itx", "apiV2"],
    priority: 10,
  }),
  configured({
    ingressRouteName: "docs-host",
    requestMatcher: { url: { hostname: "docs.example.com" } },
    target: ["itx", "docs"],
  }),
  configured({
    ingressRouteName: "canary",
    requestMatcher: { headers: { "X-Canary": "1" } },
    target: ["itx", "canary"],
  }),
  configured({
    ingressRouteName: "b-catch-all",
    requestMatcher: {},
    target: ["itx", "b"],
    priority: -1,
  }),
  configured({
    ingressRouteName: "a-catch-all",
    requestMatcher: {},
    target: ["itx", "a"],
    priority: -1,
  }),
]).ingressRoutes;

test.for<{ name: string; url: string; headers: Record<string, string>; ingressRouteName: string }>([
  {
    name: "the routing slug the edge stamped",
    url: "https://blog--acme.iterate.app/",
    headers: { "x-iterate-routing-slug": "blog" },
    ingressRouteName: "tunnel-blog",
  },
  {
    name: "the apex has no routing slug, so a slug route never takes it",
    url: "https://acme.iterate.app/",
    headers: {},
    ingressRouteName: "a-catch-all",
  },
  {
    name: "a URLPattern pathname, and the higher priority wins over the slug route",
    url: "https://blog--acme.iterate.app/api/v2/pets?id=1",
    headers: { "x-iterate-routing-slug": "blog" },
    ingressRouteName: "api-v2",
  },
  {
    name: "a pathname the pattern does not cover falls through",
    url: "https://acme.iterate.app/api/v1/pets",
    headers: {},
    ingressRouteName: "a-catch-all",
  },
  {
    name: "a URLPattern hostname (a custom domain)",
    url: "https://docs.example.com/guide",
    headers: {},
    ingressRouteName: "docs-host",
  },
  {
    name: "a header, its name case-insensitive, its value exact",
    url: "https://acme.iterate.app/",
    headers: { "x-canary": "1" },
    ingressRouteName: "canary",
  },
  {
    name: "a header value that differs does not match",
    url: "https://acme.iterate.app/",
    headers: { "x-canary": "yes" },
    ingressRouteName: "a-catch-all",
  },
  {
    name: "tied on priority, the name decides",
    url: "https://other--acme.iterate.app/",
    headers: { "x-iterate-routing-slug": "other" },
    ingressRouteName: "a-catch-all",
  },
])("matchIngressRoute: $name", ({ url, headers, ingressRouteName }) => {
  expect(matchIngressRoute(table, { url, headers: new Headers(headers) })).toMatchObject({
    ingressRouteName,
  });
});

test("matchIngressRoute: an empty table, or no route whose matcher holds, is null", () => {
  expect(
    matchIngressRoute({}, { url: "https://acme.iterate.app/", headers: new Headers() }),
  ).toBeNull();
  const { "a-catch-all": _a, "b-catch-all": _b, ...withoutCatchAll } = table;
  expect(
    matchIngressRoute(withoutCatchAll, {
      url: "https://acme.iterate.app/",
      headers: new Headers(),
    }),
  ).toBeNull();
});

/** One `ingress-route/configured` fact. */
function configured(payload: Record<string, unknown>) {
  return { type: "events.iterate.com/ingress-route/configured", payload };
}
