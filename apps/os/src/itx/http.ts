// HTTP routing to capabilities: any cap whose surface includes
// fetch(Request) is routable at its own hostname:
//
//     https://{cap}--{projectId}.{projectHostnameBase}/…
//
// Subdomain-per-cap, never path-under-project-origin: agent-authored HTML on
// the project's main origin would be XSS into its cookies. Cap names are JS
// identifiers (no dashes), so the first `--` in the label is unambiguous.
// Project ingress itself is this same rule applied to cap #0: the config
// worker serves the bare project hostname.
//
// Routable = public: meta.http.expose is the one switch. An unexposed cap
// does not exist as a hostname (404); an exposed cap answers anyone.

import { WorkerEntrypoint } from "cloudflare:workers";
import { contextAddress, dialContext, projectContextRef } from "./coordinates.ts";

export type ItxCapabilityIngressProps = {
  capability: string;
  projectId: string;
};

/**
 * The router target for cap hosts. Exposure check, then one core dispatch:
 * itx().invoke({ path: [...capPath, "fetch"], args: [request] }) — a members
 * cap exposes fetch() directly; a path-call cap sees { path: ["fetch"] } and
 * can implement HTTP however it likes.
 */
export class ItxCapabilityIngress extends WorkerEntrypoint<Env, ItxCapabilityIngressProps> {
  async fetch(request: Request): Promise<Response> {
    const props = this.ctx.props;
    const node = dialContext(this.env, contextAddress(projectContextRef(props.projectId)));

    // The host label was lowercased by normalizeIngressHost, but cap names
    // may contain uppercase — match case-insensitively so `myCap` is routable
    // at `mycap--{project}`. (Collisions that differ only by case are the
    // owner's problem; first exposed match wins.)
    const wanted = props.capability.toLowerCase();
    const described = await node.itx().describe();
    const capability = described.find((candidate) => candidate.name.toLowerCase() === wanted);
    if (!capability || capability.meta.http?.expose !== true) {
      return new Response("Not Found", { status: 404 });
    }

    return (await node.itx().invoke({
      args: [request],
      // The core's exact name (not the lowercased host label) is the
      // dot-joined entry path; the full call path is entry path + "fetch".
      path: [...capability.name.split("."), "fetch"],
    })) as Response;
  }
}
