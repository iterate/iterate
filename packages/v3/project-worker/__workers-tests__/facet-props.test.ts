// __workers-tests__/facet-props.test.ts — THE platform probe the processor layer leans on: a facet
// started from a Worker-Loader class minted with `getDurableObjectClass(name, { props })` sees those
// props as `this.ctx.props`. That is how a processor's host (its `StreamProcessorDurableObject`
// subclass) learns its identity (`{ contextName, name }`) with no configure() side channel — the
// parent passes props at mint, the only party that knows them. Pinned here in the workers lane
// because it needs a real DurableObjectState (`state.facets`) and a real LOADER: runInDurableObject
// hands us both.

import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { stub } from "./support.ts";

const PROBE_SRC = /* js */ `
import { DurableObject } from "cloudflare:workers";
export class ProbeDurableObject extends DurableObject {
  identity() {
    return {
      props: this.ctx.props ?? null,
      idName: this.ctx.id?.name ?? null,
      exportsKind: typeof this.ctx.exports,
    };
  }
}
`;

test("a facet from getDurableObjectClass(name, { props }) sees ctx.props", async () => {
  const seen = await runInDurableObject(stub("prj_facet_props_probe"), async (_instance, state) => {
    const loader = (env as unknown as { LOADER: WorkerLoader }).LOADER;
    // A fixed key: low-cardinality by construction (the loader cacheKey rule), test-lane only.
    const worker = loader.get("probe:facet-props:v1", () => ({
      compatibilityDate: "2026-09-01",
      mainModule: "probe.js",
      modules: { "probe.js": PROBE_SRC },
    }));
    const props = { contextName: state.id.name, name: "probe" };
    const klass = worker.getDurableObjectClass("ProbeDurableObject", { props });
    const facet = state.facets.get("probe", () => ({ class: klass })) as unknown as {
      identity(): Promise<{ props: unknown; idName: string | null; exportsKind: string }>;
    };
    return { props, identity: await facet.identity() };
  });

  // THE claim: props minted at getDurableObjectClass arrive as ctx.props inside the facet.
  expect(seen.identity.props).toEqual(seen.props);
  // What else a facet can see about itself, pinned so a platform change shows up here (measured
  // 2026-09-01, workerd via wrangler 4.127.1): a facet's `ctx.id.name` is its PARENT's codec name,
  // and `ctx.exports` is populated. Props still carry the facet's own `name`, which the id cannot.
  expect(seen.identity.idName).toBe(seen.props.contextName);
  expect(seen.identity.exportsKind).toBe("object");
});
