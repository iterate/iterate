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
//   fetch-middleware               depends on the same external echo service;
//                                  the middleware behavior itself (shadow +
//                                  itx.super delegation, both egress doors) is
//                                  the locked acceptance e2e in
//                                  itx-extend.e2e.test.ts ("MIDDLEWARE — …")
//   repo-sourced-capability        a real git push + per-commit build + the
//                                  ~10s "latest" probe window — too slow/flaky
//                                  for the per-runtime matrix; proven end to
//                                  end by the litmus e2e in itx.e2e.test.ts
//                                  ("user-space caps: repo-sourced code …")
//   mcp-authenticated              needs a real Cloudflare API token stored as
//                                  a project secret; proven end to end (incl.
//                                  the placeholder-never-material negative
//                                  controls) by itx-mcp-auth.e2e.test.ts
//   openapi-client                 depends on the live petstore demo server
//                                  (and the provide-time describeItx probe's
//                                  cold-start retry); proven end to end by
//                                  itx-openapi.e2e.test.ts

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
  "fetch-middleware",
  "mcp-authenticated",
  "openapi-client",
  "provide-live-capability",
  "repo-sourced-capability",
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
  "provide-plain-object": {
    assert: (result) => {
      expect(result).toEqual({
        deep: { answer: 42, question: "life, the universe, everything" },
        ultimate: 42,
      });
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
  "extend-child-context": {
    assert: (result) => {
      expect(result).toMatchObject({ fromChild: "child" });
      const capabilities = (result as { capabilities: Array<{ from?: string; name: string }> })
        .capabilities;
      // The shadow is the child's OWN entry (no provenance field); platform
      // defaults arrive through the chain labeled from: "platform".
      const shared = capabilities.filter((entry) => entry.name === "shared");
      expect(shared).toHaveLength(1);
      expect(shared[0]!.from).toBeUndefined();
      expect(capabilities.find((entry) => entry.name === "fetch")?.from).toBe("platform");
    },
  },
  "journal-is-the-record": {
    vars: ({ marker }) => ({ capName: `journal_${marker.replace(/-/g, "_")}` }),
    assert: (result) => {
      expect(result).toEqual({ record: ["capability-provided", "capability-revoked"] });
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
