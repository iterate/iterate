// __workers-tests__/facet-from-exports.test.ts — THE platform probe the first-party facets lean on: a
// facet hosted from a class THIS worker exports is `ctx.exports.<Class>({ props })` — the export is
// a loopback namespace (the class is declared in wrangler's `exports`, storage and all), calling it
// with props mints the DurableObjectClass `ctx.facets.get` takes, and inside the facet those props
// are `this.ctx.props`; the class runs with the worker's real env and reaches its context through
// the loopback it mints itself from them (sdk/index.ts `#itxEntrypoint`). Pinned in the workers
// lane because it needs a real DurableObjectState (`state.facets`, `state.exports`); measured
// 2026-09-16, wrangler 4.107 / workerd via @cloudflare/vitest-plugin 1.1.7.
import { runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import { stub } from "./support.ts";

type ExportedFacetClass = (options: {
  props: { iterateContextName: string; name: string };
}) => unknown;

test("a facet from ctx.exports.<Class>({ props }) sees ctx.props and answers through its own loopback", async () => {
  const seen = await runInDurableObject(
    stub("prj_facet_exports_probe"),
    async (_instance, state) => {
      const exportsOf = (state as unknown as { exports: Record<string, unknown> }).exports;
      const entry = exportsOf.ProjectDurableObject as ExportedFacetClass;
      const props = { iterateContextName: state.id.name!, name: "project" };
      const klass = entry({ props });
      const facet = state.facets.get("project", () => ({ class: klass as never })) as unknown as {
        snapshot(): Promise<{ offset: number; state: unknown }>;
      };
      return {
        entryKind: Object.getPrototypeOf(entry)?.constructor?.name,
        classKind: Object.getPrototypeOf(klass)?.constructor?.name,
        // `snapshot()` catches up from the context's log through `withItx` — the loopback the class
        // minted from its props — so a fresh context answers the processor's empty view.
        snapshot: await facet.snapshot(),
      };
    },
  );
  expect(seen.entryKind).toBe("LoopbackDurableObjectNamespace");
  expect(seen.classKind).toBe("DurableObjectClass");
  expect(seen.snapshot.state).toEqual({ repos: {}, workspaces: {}, agents: {} });
});

test("a first-party facet name refuses a spec — no source ever names a class of this worker", async () => {
  const context = stub("prj_facet_exports_refusal");
  await expect(
    (context as unknown as { invoke(call: unknown): Promise<unknown> }).invoke([
      "itx",
      "facets",
      ["get", "repo", { source: { "cap.js": "export class X {}" }, className: "X" }],
      ["tip"],
    ]),
  ).rejects.toThrow(/first-party/);
  await expect(
    (context as unknown as { invoke(call: unknown): Promise<unknown> }).invoke([
      "itx",
      "processors",
      ["enable", "agent", { source: { "cap.js": "export class X {}" }, className: "X" }],
    ]),
  ).rejects.toThrow(/first-party/);
});
