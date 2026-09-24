// src/ingress-routes/processor.ts — THE INGRESS ROUTES PROCESSOR: the pure reduce of the
// `ingress-route/configured` facts into the route table, and the one reader over it,
// `matchIngressRoute`. No effect lives here: forwarding a matched request is the built-in's
// (`itx.ingressRoutes.fetch`, context/built-ins.ts). Imports only the pure kernel, the contract and
// the routing slug's header name (import-free), so a unit test constructs it with `new`
// (processor.test.ts, in node).
import { ITERATE_ROUTING_SLUG_HEADER } from "iterate/project-ingress";
import { type ConsumedEvent, type ReduceArgs, StreamProcessor } from "iterate/stream/processor";
import {
  IngressRoutesContract,
  type IngressRoute,
  type IngressRouteRequestMatcher,
  type IngressRoutesState,
} from "./contract.ts";

export class IngressRoutesProcessor extends StreamProcessor<
  IngressRoutesState,
  ConsumedEvent<typeof IngressRoutesContract>
> {
  readonly contract = IngressRoutesContract;

  override reduce({
    state,
    event,
  }: ReduceArgs<IngressRoutesState, ConsumedEvent<typeof IngressRoutesContract>>):
    | IngressRoutesState
    | undefined {
    switch (event.type) {
      case "events.iterate.com/ingress-route/configured": {
        const { ingressRouteName, requestMatcher, target, authRequirement, priority } =
          event.payload;
        if (!requestMatcher) {
          if (!state.ingressRoutes[ingressRouteName]) return undefined;
          const { [ingressRouteName]: _deleted, ...ingressRoutes } = state.ingressRoutes;
          return { ...state, ingressRoutes };
        }
        return {
          ...state,
          ingressRoutes: {
            ...state.ingressRoutes,
            [ingressRouteName]: {
              requestMatcher,
              target: target!, // the contract refuses a matcher without a target
              authRequirement: authRequirement || null,
              priority: priority || 0,
              configuredOffset: event.offset,
            },
          },
        };
      }
      default:
        return undefined;
    }
  }
}

/** THE MATCH: the first route whose every matcher field holds for `request` — by priority, highest
 *  first, then by name — or null. The routing slug is the edge's `x-iterate-routing-slug` (absent on
 *  the apex, so a route naming one never takes the apex); the URL is the one the app sees. */
export function matchIngressRoute(
  ingressRoutes: IngressRoutesState["ingressRoutes"],
  request: { url: string; headers: Headers },
): IngressRoute | null {
  const ordered = Object.entries(ingressRoutes).sort(
    ([nameA, routeA], [nameB, routeB]) =>
      routeB.priority - routeA.priority || (nameA < nameB ? -1 : nameA > nameB ? 1 : 0),
  );
  for (const [ingressRouteName, route] of ordered)
    if (requestMatcherHolds(route.requestMatcher, request)) return { ingressRouteName, ...route };
  return null;
}

function requestMatcherHolds(
  requestMatcher: IngressRouteRequestMatcher,
  request: { url: string; headers: Headers },
): boolean {
  const { routingSlug, url, headers } = requestMatcher;
  if (routingSlug && request.headers.get(ITERATE_ROUTING_SLUG_HEADER) !== routingSlug) return false;
  if (url && !new URLPattern(url).test(request.url)) return false;
  for (const [name, value] of Object.entries(headers || {}))
    if (request.headers.get(name) !== value) return false;
  return true;
}
