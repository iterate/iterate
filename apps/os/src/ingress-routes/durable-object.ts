// src/ingress-routes/durable-object.ts — THE INGRESS ROUTES: the `ingress-routes` facet on the
// project's root `/`, hosting the ingress routes processor (processor.ts). `snapshot()` is the route
// table `itx.ingressRoutes` reads (context/built-ins.ts). Hosted from `ctx.exports`
// (first-party-facets.ts): ordinary bundled worker code, enabled as a row on `/` by the first
// `itx.ingressRoutes.set`.
import { StreamProcessorDurableObject, type ItxEntrypointService } from "iterate/sdk";
import type { ItxEntrypointScope } from "../iterate-context.ts";
import type { IngressRoutesState } from "./contract.ts";
import { IngressRoutesProcessor } from "./processor.ts";

export class IngressRoutesDurableObject extends StreamProcessorDurableObject<
  IngressRoutesState,
  { ITX?: ItxEntrypointService },
  ItxEntrypointScope
> {
  processor = new IngressRoutesProcessor();
}
