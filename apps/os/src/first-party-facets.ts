// src/first-party-facets.ts — THE FIRST-PARTY FACETS: facet name → the Durable Object class THIS
// worker exports (worker.ts; declared in wrangler's `exports`). A context hosts one through
// `ctx.exports` — `ctx.exports.<Class>({ props })` mints the DurableObjectClass `ctx.facets.get`
// takes, and the props are the facet's identity (`{ iterateContextName, name }`, sdk/index.ts) —
// never through a loaded source: ordinary bundled worker code, with the worker's real env. THIS
// TABLE IS THE ONLY PATH from a facet name to `ctx.exports`: no FacetSpec names a class of this
// worker, and a reserved name refuses a spec (context/facet-host.ts `FacetHost#callFacet`,
// context/built-ins.ts `processors.enable`); the reduce marks a hosting row for a reserved name
// without a source (stream/core-processor.ts). Pinned: __workers-tests__/facet-from-exports.test.ts.
// WHERE each one may be hosted is context/first-party-facet-placement.ts's rules.
export const FIRST_PARTY_FACET_CLASSES = {
  account: "AccountDurableObject",
  organization: "OrganizationDurableObject",
  project: "ProjectDurableObject",
  repo: "RepoDurableObject",
  secret: "SecretDurableObject",
  workspace: "WorkspaceDurableObject",
} as const;

/** The exported class a first-party facet name hosts; undefined for every other name. */
export function firstPartyFacetClassOf(name: string): string | undefined {
  return Object.hasOwn(FIRST_PARTY_FACET_CLASSES, name)
    ? FIRST_PARTY_FACET_CLASSES[name as keyof typeof FIRST_PARTY_FACET_CLASSES]
    : undefined;
}
