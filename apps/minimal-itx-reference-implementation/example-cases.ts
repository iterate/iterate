// Assertions (and setup + vars) for the catalogue examples (examples.ts).
// Mirrors apps/os/src/itx/e2e/example-cases.ts: the catalogue stays pure data,
// so everything test-only lives here. Every runnable catalogue entry must have
// a case — the matrix test fails if one is missing, so examples can't silently
// rot.
//
// `setup` receives an already-connected itx handle for the example's context
// and prepares it (e.g. provideCapability). It is deliberately runtime-agnostic
// — it only calls verbs every stub has — so the SAME setup runs whether the
// example will execute in Node, the CLI, a worker, or a browser tab.

import { expect } from "vitest";
import { dynamicCalc, repoCounter } from "./itx-scripts.ts";

export type ExampleRunContext = {
  /** Unique per example × runtime, for any payload assertions. */
  marker: string;
  projectId: string;
};

export type ExampleCase = {
  setup?: (itx: any) => Promise<void>;
  vars?: (ctx: ExampleRunContext) => Record<string, unknown>;
  assert: (result: unknown, ctx: ExampleRunContext) => void;
};

/** Catalogue ids that intentionally have no matrix case. */
export const EXAMPLE_IDS_WITHOUT_CASES = new Set<string>([]);

export const EXAMPLE_CASES: Record<string, ExampleCase> = {
  "agent-builtin": {
    assert: (result) => {
      expect(typeof result).toBe("string");
      expect(result as string).toMatch(/^agent prj_ref:\/agents\//);
    },
  },
  "project-builtin-inherited": {
    assert: (result) => {
      expect(result).toEqual({ mainModule: "counter.js", hasCounter: true });
    },
  },
  "dynamic-worker-capability": {
    setup: async (itx) => {
      await itx.provideCapability({ path: ["calc"], capability: dynamicCalc });
    },
    vars: () => ({ a: 19, b: 23 }),
    assert: (result) => {
      expect(result).toBe(42);
    },
  },
  "dynamic-durable-object-facet": {
    setup: async (itx) => {
      await itx.provideCapability({ path: ["counter"], capability: repoCounter });
    },
    assert: (result) => {
      const value = result as { current: number; next: number };
      expect(typeof value.current).toBe("number");
      expect(value.current).toBeGreaterThanOrEqual(1);
      expect(value.current).toBe(value.next);
    },
  },
};
