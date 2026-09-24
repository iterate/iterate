// src/ingress-routes/contract.ts — A PROJECT'S INGRESS ROUTES: named rules on the project's root `/`
// that say which requests arriving on the project's hosts go to which itx expression — a tunnel's
// lent stub (`iterate tunnel`), a facet, a loaded worker. Each is one fact on `/`,
// `ingress-route/configured`, and THIS FILE is the only place it is spelled. The rest of the folder
// derives from it: processor.ts reduces the facts into the route table and matches a request against
// it (pure), durable-object.ts hosts that processor as the first-party facet `ingress-routes` on `/`.
// The verbs are the built-in `itx.ingressRoutes` (context/built-ins.ts): `set` validates here and
// appends the fact, `match` and `fetch` read the table. The project's config worker asks `match` for
// every request and forwards a match through its own `env.ITX.fetch` (configs/default/worker.ts).
//   IngressRoutesState                           = ProcessorState<typeof IngressRoutesContract>
//   ConsumedEvent<typeof IngressRoutesContract>  what reduce sees
import { z } from "zod";
import { normalizedItxExpression, type ItxExpression } from "iterate/expression";
import { defineProcessorContract, type ProcessorState } from "iterate/stream/processor";

/** A route's name: a DNS label (`tunnel-blog`, `api`), so it reads in a URL, a log line and a header. */
const IngressRouteName = z
  .string()
  .regex(
    /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/,
    "an ingress route name is a DNS label: lowercase letters, digits and inner hyphens, at most 63",
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
export const IngressRouteRequestMatcher = z.strictObject({
  routingSlug: z.string().min(1).optional(),
  url: UrlPatternInit.optional(),
  headers: z.record(z.string().min(1), z.string()).optional(),
});
export type IngressRouteRequestMatcher = z.infer<typeof IngressRouteRequestMatcher>;

/** Who may use a route: `project-members` — the config worker answers anyone else the platform's
 *  sign-in challenge. Absent or null: the route is public. */
const IngressRouteAuthRequirement = z.strictObject({
  visitors: z.literal("project-members"),
});

/** The itx expression a route forwards to, as the array half (`itx.tunnels.blog` parsed). */
const IngressRouteTarget = z.custom<ItxExpression>(
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

/** The one fact's payload — what `itx.ingressRoutes.set` validates before it appends. */
export const IngressRouteConfiguredPayload = z
  .strictObject({
    ingressRouteName: IngressRouteName,
    requestMatcher: IngressRouteRequestMatcher.nullable(),
    target: IngressRouteTarget.optional(),
    authRequirement: IngressRouteAuthRequirement.nullable().optional(),
    priority: z.number().int().optional(),
  })
  .refine((payload) => !payload.requestMatcher || Boolean(payload.target), {
    message: "a route with a requestMatcher names its target",
  });

export const IngressRoutesContract = defineProcessorContract({
  slug: "ingress-routes",
  version: "1",
  description:
    "The project's ingress routes: which requests on its hosts go to which itx expression, by name.",
  /** THE REDUCED STATE — every live route by name, as its last `configured` fact said, with the
   *  OFFSET of that fact. What `itx.ingressRoutes.list()` answers and `match` reads. */
  stateSchema: z.object({
    ingressRoutes: z
      .record(
        z.string(),
        z.object({
          requestMatcher: IngressRouteRequestMatcher,
          target: IngressRouteTarget,
          authRequirement: IngressRouteAuthRequirement.nullable(),
          priority: z.number().int(),
          configuredOffset: z.number().int().positive(),
        }),
      )
      .default({}),
  }),
  events: {
    "events.iterate.com/ingress-route/configured": {
      description:
        "A route was set (`itx.ingressRoutes.set`): the requests it takes, where they go, who may use it and its priority (higher first, then by name). A null `requestMatcher` deletes the route.",
      payloadSchema: IngressRouteConfiguredPayload,
    },
  },
  consumes: ["events.iterate.com/ingress-route/configured"],
  emits: [],
});

export type IngressRoutesState = ProcessorState<typeof IngressRoutesContract>;

/** One live route as `list()` and `match` answer it: the table's row with its name. */
export type IngressRoute = IngressRoutesState["ingressRoutes"][string] & {
  ingressRouteName: string;
};
