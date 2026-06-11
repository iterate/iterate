// Assertions for the catalogue examples (src/itx/examples.ts). The catalogue
// is UI-facing and ships to the browser, so everything test-only — vars
// construction and result assertions — lives here instead. Every catalogue
// entry that can run unattended should have a case; the matrix test fails if
// a runnable example is missing one (so examples can't silently rot).
//
// Not here by design:
//   provide-live-capability        browser-only alert flow, asserted by its
//                                  dedicated browser test (alert capture)
//   egress-with-secret-substitution depends on an external echo service;
//                                  covered by itx-egress.e2e.test.ts

import { expect } from "vitest";

export type ExampleRunContext = {
  /** Unique per example × runtime, for stream/event payload assertions. */
  marker: string;
  projectId: string;
};

export type ExampleCase = {
  vars?: (ctx: ExampleRunContext) => Record<string, unknown>;
  assert: (result: unknown, ctx: ExampleRunContext) => void;
};

/** Example ids that intentionally have no matrix case (see header). */
export const EXAMPLE_IDS_WITHOUT_CASES = new Set([
  "egress-with-secret-substitution",
  "provide-live-capability",
]);

export const EXAMPLE_CASES: Record<string, ExampleCase> = {
  "list-and-describe-project": {
    vars: ({ projectId }) => ({ projectId }),
    assert: (result, { projectId }) => {
      expect(result).toMatchObject({ context: projectId, project: { id: projectId } });
    },
  },
  "append-and-read-stream": {
    vars: ({ marker }) => ({ note: marker }),
    assert: (result, { marker }) => {
      expect(result).toMatchObject({ appended: { payload: { note: marker } } });
      expect((result as { count: number }).count).toBeGreaterThan(0);
    },
  },
  "provide-path-call-sdk": {
    assert: (result) => {
      expect(result).toMatchObject({ method: "chat.postMessage", provider: "live-session" });
    },
  },
  "provide-durable-worker-cap": {
    assert: (result) => {
      expect(result).toEqual({ greeting: "hello, world", sum: 5 });
    },
  },
  "worker-cap-uses-its-own-itx": {
    // The todo stream accumulates across runtimes (same project, same path) —
    // containment, not equality.
    assert: (result) => {
      expect(result).toContain("ship the capability layer");
      expect(result).toContain("delete the mounts");
    },
  },
  "deep-auto-proxy": {
    assert: (result) => {
      expect(result).toEqual({ echo: { echoed: { hi: 1 } }, sum: 5 });
    },
  },
  "worker-to-worker": {
    assert: (result) => {
      expect(result).toEqual({ count: 7, price: 42, total: 294 });
    },
  },
  "stateful-facet-cap": {
    // The counter facet persists across runtimes — strictly positive and even
    // (each run increments twice), not exactly 2.
    assert: (result) => {
      const current = (result as { current: number }).current;
      expect(typeof current).toBe("number");
      expect(current).toBeGreaterThanOrEqual(2);
    },
  },
  "fork-child-context": {
    assert: (result) => {
      expect(result).toMatchObject({ fromChild: { from: "child", method: "ping" } });
    },
  },
  "http-cap-and-share-url": {
    assert: (result) => {
      const shareUrl = (result as { shareUrl: string }).shareUrl;
      expect(typeof shareUrl).toBe("string");
      expect(shareUrl).toContain("hello--");
      expect(() => new URL(shareUrl)).not.toThrow();
    },
  },
  "import-npm-via-esm-sh": {
    assert: (result, { projectId }) => {
      expect(result).toMatchObject({ context: projectId, project: { id: projectId } });
    },
  },
};
