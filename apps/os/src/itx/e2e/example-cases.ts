// Assertions for the catalogue examples (src/itx/examples.ts). The catalogue
// is UI-facing and ships to the browser, so everything test-only — vars
// construction and result assertions — lives here instead. Every catalogue
// entry that can run unattended should have a case; the matrix test fails if
// a runnable example is missing one (so examples can't silently rot).
//
// Not here by design:
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
//   mcp-client                     depends on Cloudflare's live public docs
//                                  MCP server; the same flow is the
//                                  always-running e2e in itx-mcp-auth.e2e.test.ts
//                                  ("public MCP: …")
//   mcp-authenticated              needs a real Cloudflare API token stored as
//                                  a project secret; proven end to end (incl.
//                                  the placeholder-never-material negative
//                                  controls) by itx-mcp-auth.e2e.test.ts
//   secrets-and-egress             depends on the same external echo service;
//                                  the setSecret → placeholder-fetch flow is
//                                  the "itx.secrets" e2e in
//                                  itx-egress.e2e.test.ts
//   openapi-client                 the catalogue snippet points at the live
//                                  petstore demo; the same flow is proven
//                                  deterministically against the deployment's
//                                  own fixture in itx-openapi.e2e.test.ts

export type ExampleRunContext = {
  /** Unique per example × runtime, for stream/event payload assertions. */
  marker: string;
  projectId: string;
};

export type ExampleCase = {
  vars?: (ctx: ExampleRunContext) => Record<string, unknown>;
  assert: (result: unknown, ctx: ExampleRunContext, expect: typeof import("vitest").expect) => void;
};

/** Example ids that intentionally have no matrix case (see header). */
export const EXAMPLE_IDS_WITHOUT_CASES = new Set([
  "egress-with-secret-substitution",
  "fetch-middleware",
  "mcp-authenticated",
  "mcp-client",
  "openapi-client",
  "repo-sourced-capability",
  "secrets-and-egress",
]);

export const EXAMPLE_CASES: Record<string, ExampleCase> = {
  "list-and-describe-project": {
    vars: ({ projectId }) => ({ projectId }),
    assert: (result, { projectId }, expect) => {
      expect(result).toMatchObject({ context: `${projectId}:/`, project: { id: projectId } });
    },
  },
  "append-and-read-stream": {
    vars: ({ marker }) => ({ note: marker }),
    assert: (result, { marker }, expect) => {
      expect(result).toMatchObject({ appended: { payload: { note: marker } } });
      expect((result as { count: number }).count).toBeGreaterThan(0);
    },
  },
  "provide-plain-object": {
    assert: (result, _ctx, expect) => {
      expect(result).toEqual({
        deep: { answer: 42, question: "life, the universe, everything" },
        ultimate: 42,
      });
    },
  },
  "provide-path-call-sdk": {
    assert: (result, _ctx, expect) => {
      expect(result).toMatchObject({ method: "chat.postMessage", provider: "live-session" });
    },
  },
  "provide-durable-worker-cap": {
    assert: (result, _ctx, expect) => {
      expect(result).toEqual({ greeting: "hello, world", sum: 5 });
    },
  },
  "worker-cap-uses-its-own-itx": {
    // The todo stream accumulates across runtimes (same project, same path) —
    // containment, not equality.
    assert: (result, _ctx, expect) => {
      expect(result).toContain("ship the capability layer");
      expect(result).toContain("delete the mounts");
    },
  },
  "deep-auto-proxy": {
    assert: (result, _ctx, expect) => {
      expect(result).toEqual({ echo: { echoed: { hi: 1 } }, sum: 5 });
    },
  },
  "worker-to-worker": {
    assert: (result, _ctx, expect) => {
      expect(result).toEqual({ count: 7, price: 42, total: 294 });
    },
  },
  "stateful-facet-cap": {
    // The counter facet persists across runtimes — strictly positive and even
    // (each run increments twice), not exactly 2.
    assert: (result, _ctx, expect) => {
      const current = (result as { current: number }).current;
      expect(typeof current).toBe("number");
      expect(current).toBeGreaterThanOrEqual(2);
    },
  },
  "extend-child-context": {
    assert: (result, _ctx, expect) => {
      expect(result).toMatchObject({ fromChild: "child" });
      const capabilities = (result as { capabilities: Array<{ from?: string; name: string }> })
        .capabilities;
      // The shadow is the child's OWN entry (no provenance field); the
      // defaults arrive through the chain labeled from: "defaults".
      const shared = capabilities.filter((entry) => entry.name === "shared");
      expect(shared).toHaveLength(1);
      expect(shared[0]!.from).toBeUndefined();
      expect(capabilities.find((entry) => entry.name === "fetch")?.from).toBe("defaults");
    },
  },
  "journal-is-the-record": {
    vars: ({ marker }) => ({ capName: `journal_${marker.replace(/-/g, "_")}` }),
    assert: (result, _ctx, expect) => {
      expect(result).toEqual({ record: ["capability-provided", "capability-revoked"] });
    },
  },
  "http-cap": {
    assert: (result, _ctx, expect) => {
      const url = (result as { url: string }).url;
      expect(typeof url).toBe("string");
      expect(url).toContain("hello--");
      expect(() => new URL(url)).not.toThrow();
    },
  },
  "import-npm-via-esm-sh": {
    assert: (result, { projectId }, expect) => {
      expect(result).toMatchObject({ context: `${projectId}:/`, project: { id: projectId } });
    },
  },
};
