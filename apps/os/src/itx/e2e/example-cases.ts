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
  assert: (result: unknown, ctx: ExampleRunContext) => void;
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
    assert: (result, { projectId }) => {
      assertMatchesObject(result, { context: `${projectId}:/`, project: { id: projectId } });
    },
  },
  "append-and-read-stream": {
    vars: ({ marker }) => ({ note: marker }),
    assert: (result, { marker }) => {
      assertMatchesObject(result, { appended: { payload: { note: marker } } });
      assertGreaterThan((result as { count: number }).count, 0, "result.count");
    },
  },
  "provide-plain-object": {
    assert: (result) => {
      assertDeepEqual(result, {
        deep: { answer: 42, question: "life, the universe, everything" },
        ultimate: 42,
      });
    },
  },
  "provide-path-call-sdk": {
    assert: (result) => {
      assertMatchesObject(result, { method: "chat.postMessage", provider: "live-session" });
    },
  },
  "provide-durable-worker-cap": {
    assert: (result) => {
      assertDeepEqual(result, { greeting: "hello, world", sum: 5 });
    },
  },
  "worker-cap-uses-its-own-itx": {
    // The todo stream accumulates across runtimes (same project, same path) —
    // containment, not equality.
    assert: (result) => {
      assertContains(result, "ship the capability layer", "result");
      assertContains(result, "delete the mounts", "result");
    },
  },
  "deep-auto-proxy": {
    assert: (result) => {
      assertDeepEqual(result, { echo: { echoed: { hi: 1 } }, sum: 5 });
    },
  },
  "worker-to-worker": {
    assert: (result) => {
      assertDeepEqual(result, { count: 7, price: 42, total: 294 });
    },
  },
  "stateful-facet-cap": {
    // The counter facet persists across runtimes — strictly positive and even
    // (each run increments twice), not exactly 2.
    assert: (result) => {
      const current = (result as { current: number }).current;
      assert(typeof current === "number", `Expected result.current to be a number, got ${current}`);
      assertGreaterThanOrEqual(current, 2, "result.current");
    },
  },
  "extend-child-context": {
    assert: (result) => {
      assertMatchesObject(result, { fromChild: "child" });
      const capabilities = (result as { capabilities: Array<{ from?: string; name: string }> })
        .capabilities;
      // The shadow is the child's OWN entry (no provenance field); the
      // defaults arrive through the chain labeled from: "defaults".
      const shared = capabilities.filter((entry) => entry.name === "shared");
      assertLength(shared, 1, "shared capabilities");
      assert(
        shared[0]!.from === undefined,
        `Expected child shared capability to have no provenance, got ${shared[0]!.from}`,
      );
      const fetchCapability = capabilities.find((entry) => entry.name === "fetch");
      assertDeepEqual(fetchCapability?.from, "defaults", "fetch capability provenance");
    },
  },
  "journal-is-the-record": {
    vars: ({ marker }) => ({ capName: `journal_${marker.replace(/-/g, "_")}` }),
    assert: (result) => {
      assertDeepEqual(result, { record: ["capability-provided", "capability-revoked"] });
    },
  },
  "http-cap": {
    assert: (result) => {
      const url = (result as { url: string }).url;
      assert(typeof url === "string", `Expected result.url to be a string, got ${url}`);
      assertContains(url, "hello--", "result.url");
      assertValidUrl(url, "result.url");
    },
  },
  "import-npm-via-esm-sh": {
    assert: (result, { projectId }) => {
      assertMatchesObject(result, { context: `${projectId}:/`, project: { id: projectId } });
    },
  },
};

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertGreaterThan(actual: unknown, expected: number, label: string) {
  assert(
    typeof actual === "number" && actual > expected,
    `Expected ${label} to be greater than ${expected}, got ${formatValue(actual)}`,
  );
}

function assertGreaterThanOrEqual(actual: unknown, expected: number, label: string) {
  assert(
    typeof actual === "number" && actual >= expected,
    `Expected ${label} to be at least ${expected}, got ${formatValue(actual)}`,
  );
}

function assertLength(actual: unknown[], expected: number, label: string) {
  assert(
    actual.length === expected,
    `Expected ${label} to have length ${expected}, got ${actual.length}: ${formatValue(actual)}`,
  );
}

function assertContains(container: unknown, item: unknown, label: string) {
  assert(
    (typeof container === "string" && typeof item === "string" && container.includes(item)) ||
      (Array.isArray(container) && container.includes(item)),
    `Expected ${label} to contain ${formatValue(item)}, got ${formatValue(container)}`,
  );
}

function assertMatchesObject(actual: unknown, expected: unknown, label = "result") {
  if (isPlainObject(expected)) {
    assert(isPlainObject(actual), `Expected ${label} to be an object, got ${formatValue(actual)}`);
    for (const [key, value] of Object.entries(expected)) {
      assertMatchesObject((actual as Record<string, unknown>)[key], value, `${label}.${key}`);
    }
    return;
  }

  assertDeepEqual(actual, expected, label);
}

function assertDeepEqual(actual: unknown, expected: unknown, label = "result") {
  assert(
    deepEqual(actual, expected),
    `Expected ${label} to equal ${formatValue(expected)}, got ${formatValue(actual)}`,
  );
}

function assertValidUrl(value: string, label: string) {
  try {
    new URL(value);
  } catch (error) {
    throw new Error(
      `Expected ${label} to be a valid URL, got ${formatValue(value)}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;
    return left.every((value, index) => deepEqual(value, right[index]));
  }
  if (isPlainObject(left) || isPlainObject(right)) {
    if (!isPlainObject(left) || !isPlainObject(right)) return false;
    const leftEntries = Object.entries(left);
    const rightEntries = Object.entries(right);
    if (leftEntries.length !== rightEntries.length) return false;
    return leftEntries.every(([key, value]) => deepEqual(value, right[key]));
  }
  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatValue(value: unknown) {
  try {
    return JSON.stringify(value) || String(value);
  } catch {
    return String(value);
  }
}
