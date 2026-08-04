// The three-layer world, built from ONE CapabilityHost class:
//
//     iterate  (mounted as a capability on the control plane)
//        ▲ provides: flavor (live), brandName (static)
//        │
//   control-plane  (provides capabilities DOWN to projects)
//        ▲ provides: iterate (the mounted host), egress/fetch (live)
//        │  parent-of
//     project  (falls through to the control plane for anything it lacks)
//
// A project has NO raw fetch — "fetch out of a project is a provided capability from
// the control plane." `project.egress.fetch(url)` misses locally, falls through to the
// control plane's egress capability, which performs (and could mediate) the real call.

import { RpcTarget } from "capnweb";
import { CapabilityHost } from "./capability-host.mjs";

// iterate's flavor capability — LIVE (methods run where the object lives).
class IterateFlavor extends RpcTarget {
  flavorPrompt(kind) {
    return `You are an iterate-flavoured ${kind}.`;
  }
}

// The control plane's egress door, provided DOWN to projects. LIVE. `doFetch` is the
// real outbound call, injected by the host environment (Node mock, or workerd fetch).
class Egress extends RpcTarget {
  #doFetch;
  constructor(doFetch) {
    super();
    this.#doFetch = doFetch;
  }
  async fetch(url) {
    // A real control plane would substitute secrets / origin-pin here. We just tag it.
    const res = await this.#doFetch(url);
    return { via: "control-plane egress", status: res.status, body: res.body };
  }
}

/**
 * Build the iterate ← control-plane ← project graph. `parents` lets a caller wire the
 * project's parent as a REMOTE stub (cross-isolate) instead of the local CP object.
 *   egressFetch: async (url) => ({ status, body })  — the real outbound call.
 */
export function buildGraph({ egressFetch } = {}) {
  const doFetch = egressFetch ?? (async (url) => ({ status: 200, body: `pong from ${url}` }));

  const iterate = new CapabilityHost("iterate");
  iterate.provide("flavor", new IterateFlavor(), "live"); // live capability
  iterate.provide("brandName", "iterate", "static"); // static (pass-by-value) capability

  const controlPlane = new CapabilityHost("control-plane");
  controlPlane.provide("iterate", iterate, "live"); // iterate is a MOUNTED capability
  controlPlane.provide("egress", new Egress(doFetch), "live"); // provided DOWN to projects

  const project = new CapabilityHost("project");
  project.setParent(controlPlane); // falls through to the control plane

  return { iterate, controlPlane, project };
}

/**
 * Exercise the whole design against a `project` handle (a local host OR a remote stub).
 * Everything below should pipeline; a remote parent adds one hop but no extra round trip
 * from the caller's view. Returns a plain result object so it survives RPC.
 */
export async function runDemo(project) {
  // 1. Fall through project → control-plane → mounted iterate → live flavor method.
  const flavorPrompt = await project.iterate.flavor.flavorPrompt("assistant");
  // 2. A STATIC capability resolved the same way (pass-by-value).
  const brandName = await project.iterate.brandName;
  // 3. Egress: the project has no fetch; it falls through to the CP's egress capability.
  const egress = await project.egress.fetch("https://example.test/egress-target");
  // 4. SHADOWING: the project provides its OWN egress; local mount wins over the parent.
  await project.provide(
    "egress",
    new (class extends RpcTarget {
      async fetch(url) {
        return { via: "project-local egress (shadowed)", status: 299, body: `local ${url}` };
      }
    })(),
    "live",
  );
  const shadowedEgress = await project.egress.fetch("https://example.test/hello");

  return { flavorPrompt, brandName, egress, shadowedEgress };
}

// The expected result, so both node and workerd harnesses can assert identically.
export const EXPECTED = {
  flavorPrompt: "You are an iterate-flavoured assistant.",
  brandName: "iterate",
  egressVia: "control-plane egress",
  shadowedVia: "project-local egress (shadowed)",
};

export function checkDemo(r) {
  const problems = [];
  if (r.flavorPrompt !== EXPECTED.flavorPrompt)
    problems.push(`flavorPrompt=${JSON.stringify(r.flavorPrompt)}`);
  if (r.brandName !== EXPECTED.brandName) problems.push(`brandName=${JSON.stringify(r.brandName)}`);
  if (r.egress?.via !== EXPECTED.egressVia)
    problems.push(`egress.via=${JSON.stringify(r.egress?.via)}`);
  if (r.shadowedEgress?.via !== EXPECTED.shadowedVia)
    problems.push(`shadowedEgress.via=${JSON.stringify(r.shadowedEgress?.via)}`);
  return problems;
}
