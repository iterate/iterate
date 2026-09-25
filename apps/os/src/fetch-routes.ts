// src/fetch-routes.ts — A PROJECT'S FETCH ROUTES: named rules on the project's root `/` that say
// which requests arriving on the project's hosts go to which itx expression — a tunnel's lent stub
// (`iterate tunnel`), a facet, a loaded worker. Each is one fact on `/`,
// `itx/fetch-route-configured`, and THIS FILE is the only place it is spelled, folded into the route
// table (`reduceFetchRouteConfigured`) and matched against a request (`matchFetchRoute`), all
// pure. The table is part of the root's CORE STATE (stream/core-processor.ts `fetchRoutes`), reduced
// inline with every commit, so reading it is a memory read. The verbs are the built-in
// `itx.fetchRoutes` (context/built-ins.ts): `set` validates here and appends the fact, `list`,
// `match` and `fetch` read the table. The project's config worker asks `match` for every request and
// forwards a match through its own `env.ITX.fetch` (configs/default/worker.ts).
import { z } from "zod";
import { normalizedItxExpression, type ItxExpression } from "iterate/expression";
import { ITERATE_ROUTING_SLUG_HEADER } from "iterate/project-ingress";

/** A route's name: a DNS label (`tunnel-blog`, `api`), so it reads in a URL, a log line and a header. */
const FetchRouteName = z
  .string()
  .regex(
    /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/,
    "a fetch route name is a DNS label: lowercase letters, digits and inner hyphens, at most 63",
  );

/** The fields of a standard `URLPatternInit`, each a pattern string; refused unless `URLPattern`
 *  compiles it. */
const UrlPatternInit = z
  .strictObject({
    protocol: z.string().optional(),
    username: z.string().optional(),
    password: z.string().optional(),
    hostname: z.string().optional(),
    port: z.string().optional(),
    pathname: z.string().optional(),
    search: z.string().optional(),
    hash: z.string().optional(),
    baseURL: z.string().optional(),
  })
  .refine(
    (init) => {
      try {
        new URLPattern(init);
        return true;
      } catch {
        return false;
      }
    },
    { message: "url is not a URLPattern" },
  );

/** WHICH requests a route takes — every field given must hold: the host's routing slug (the
 *  `x-iterate-routing-slug` the edge stamps; absent on the apex), the URL the app sees against a
 *  standard `URLPattern`, and exact header values (names case-insensitive). `{}` takes every request. */
const FetchRouteRequestMatcher = z.strictObject({
  routingSlug: z.string().min(1).optional(),
  url: UrlPatternInit.optional(),
  headers: z.record(z.string().min(1), z.string()).optional(),
});
type FetchRouteRequestMatcher = z.infer<typeof FetchRouteRequestMatcher>;

/** Who may use a route: `project-members` — the config worker answers anyone else the platform's
 *  sign-in challenge. Absent or null: the route is public. */
const FetchRouteAuthRequirement = z.strictObject({
  visitors: z.literal("project-members"),
});

/** The itx expression a route forwards to, as the array half (`itx.tunnels.blog` parsed). */
const FetchRouteTarget = z.custom<ItxExpression>(
  (value) => {
    try {
      // the normalizer is the check: it throws on anything that is not an itx expression
      normalizedItxExpression(value as ItxExpression);
      return Array.isArray(value);
    } catch {
      return false;
    }
  },
  { message: "target is an itx expression (the array half)" },
);

/** The one fact's payload — what `itx.fetchRoutes.set` validates before it appends, and what the
 *  append boundary checks on any other append (stream/core-processor.ts `normalizeControlEvent`).
 *  A null `requestMatcher` deletes the route. */
export const FetchRouteConfiguredPayload = z
  .strictObject({
    fetchRouteName: FetchRouteName,
    requestMatcher: FetchRouteRequestMatcher.nullable(),
    target: FetchRouteTarget.optional(),
    authRequirement: FetchRouteAuthRequirement.nullable().optional(),
    priority: z.number().int().optional(),
  })
  .refine((payload) => !payload.requestMatcher || Boolean(payload.target), {
    message: "a route with a requestMatcher names its target",
  });

/** THE ROUTE TABLE — every live route by name, as its last `configured` fact said, with the OFFSET
 *  of that fact. What `itx.fetchRoutes.list()` answers and `match` reads. */
export type FetchRouteTable = Record<
  string,
  {
    requestMatcher: FetchRouteRequestMatcher;
    target: ItxExpression;
    authRequirement: z.infer<typeof FetchRouteAuthRequirement> | null;
    priority: number;
    configuredOffset: number;
  }
>;

/** One live route as `list()` and `match` answer it: the table's row with its name. */
export type FetchRoute = FetchRouteTable[string] & { fetchRouteName: string };

/** THE FOLD of one `itx/fetch-route-configured` fact: the route set at the fact's offset, or deleted
 *  by a null matcher — `undefined` when nothing changes (the core reduce's keep-the-state signal).
 *  The table is written through `writable`: a fresh copy by default, the batch's DRAFT in the core
 *  reduce (stream/core-processor.ts `draftOf`), so a page of facts copies the table once and a
 *  core-version bump re-reduces a root's routes in the DO constructor in O(routes). A copy per fact
 *  is O(routes²): 14,000 routes took ~25 s on a laptop, a reboot loop against the CPU limit, and
 *  ~0.1 s as a draft (measured 2026-09-24). A malformed payload is skipped, never thrown: the
 *  append boundary refuses one, and a fold that meets one anyway must not let a route that does
 *  not compile break every request's match. */
export function reduceFetchRouteConfigured(
  table: FetchRouteTable,
  event: { offset: number; payload?: unknown },
  writable: (table: FetchRouteTable) => FetchRouteTable = (table) => ({ ...table }),
): FetchRouteTable | undefined {
  const parsed = FetchRouteConfiguredPayload.safeParse(event.payload);
  if (!parsed.success) return undefined;
  const { fetchRouteName, requestMatcher, target, authRequirement, priority } = parsed.data;
  if (!requestMatcher && !Object.hasOwn(table, fetchRouteName)) return undefined;
  const next = writable(table);
  // A DNS label is never `__proto__`: an assignment makes an own key, `constructor` included.
  if (!requestMatcher) delete next[fetchRouteName];
  else
    next[fetchRouteName] = {
      requestMatcher,
      target: target!, // the schema refuses a matcher without a target
      authRequirement: authRequirement || null,
      priority: priority || 0,
      configuredOffset: event.offset,
    };
  return next;
}

/** THE MATCH: the first route whose every matcher field holds for `request` — by priority, highest
 *  first, then by name — or null. The routing slug is the edge's `x-iterate-routing-slug` (absent on
 *  the apex, so a route naming one never takes the apex); the URL is the one the app sees. */
export function matchFetchRoute(
  table: FetchRouteTable,
  request: { url: string; headers: Headers },
): FetchRoute | null {
  const ordered = Object.entries(table).sort(
    ([nameA, routeA], [nameB, routeB]) =>
      routeB.priority - routeA.priority || (nameA < nameB ? -1 : nameA > nameB ? 1 : 0),
  );
  for (const [fetchRouteName, route] of ordered)
    if (requestMatcherHolds(route.requestMatcher, request)) return { fetchRouteName, ...route };
  return null;
}

function requestMatcherHolds(
  requestMatcher: FetchRouteRequestMatcher,
  request: { url: string; headers: Headers },
): boolean {
  const { routingSlug, url, headers } = requestMatcher;
  if (routingSlug && request.headers.get(ITERATE_ROUTING_SLUG_HEADER) !== routingSlug) return false;
  if (url && !new URLPattern(url).test(request.url)) return false;
  for (const [name, value] of Object.entries(headers || {}))
    if (request.headers.get(name) !== value) return false;
  return true;
}
