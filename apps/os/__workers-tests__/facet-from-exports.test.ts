// __workers-tests__/facet-from-exports.test.ts — THE platform probe the first-party facets lean on: a
// facet hosted from a class THIS worker exports is `ctx.exports.<Class>({ props })` — the export is
// a loopback namespace (the class is declared in wrangler's `exports`, storage and all), calling it
// with props mints the DurableObjectClass `ctx.facets.get` takes, and inside the facet those props
// are `this.ctx.props`; the class runs with the worker's real env and reaches its context through
// the loopback it mints itself from them (sdk/index.ts `#itxEntrypoint`). Pinned in the workers
// project because it needs a real DurableObjectState (`state.facets`, `state.exports`); measured
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
  // Exact: the empty view is the point, so an extra key or a non-empty map must fail.
  expect(seen).toEqual({
    entryKind: "LoopbackDurableObjectNamespace",
    classKind: "DurableObjectClass",
    snapshot: {
      offset: expect.any(Number),
      state: {
        creation: null,
        repos: {},
        workspaces: {},
        secrets: {},
        configRepoTip: null,
        publishedCommitOid: null,
        hostnames: {},
      },
    },
  });
});

test("a first-party facet name refuses a spec — no source ever names a class of this worker", async () => {
  // Refused INSIDE the object (runInDurableObject): a rejected RPC promise crossing to the test is
  // reported as unhandled in the object whatever the caller does with it (the facet-hosting lesson).
  const refusals = await runInDurableObject(
    stub("prj_facet_exports_refusal"),
    async (instance: unknown) => {
      const context = instance as { invoke(call: unknown): Promise<unknown> };
      const refusal = async (call: unknown) => {
        try {
          await context.invoke(call);
          return null;
        } catch (error) {
          return String(error);
        }
      };
      return {
        facet: await refusal([
          "itx",
          "facets",
          ["get", "repo", { source: { "cap.js": "export class X {}" }, className: "X" }],
          ["tip"],
        ]),
        processor: await refusal([
          "itx",
          "processors",
          ["enable", "repo", { source: { "cap.js": "export class X {}" }, className: "X" }],
        ]),
      };
    },
  );
  expect(refusals.facet).toMatch(/first-party/);
  expect(refusals.processor).toMatch(/first-party/);
});
