// Assertions for the catalogue examples (src/itx/examples.ts). The catalogue
// is UI-facing and ships to the browser, so everything test-only — vars
// construction and result assertions — lives here instead. Every catalogue
// entry that can run unattended should have a case; the matrix test fails if
// a runnable example is missing one (so examples can't silently rot).
//
// Not here by design:
//   whoami          session-context: it runs against the OS Session (what
//                   authenticate() returns), not a project itx. The matrix
//                   (and the Playwright REPL specs) execute in a project scope
//                   where the Session's __describe().principal / itx.projects
//                   do not exist. Session behavior is proven by the itx e2e
//                   suites (apps/os/e2e/itx/itx.e2e.test.ts).
//   list-projects   session-context, same reason as whoami.
//   ai-models       depends on the deployment's upstream Workers AI account
//                   (catalog availability + latency); interactive reading
//                   material, not matrix material.
//   exa-web-search  calls Exa's public MCP server (external service, rate
//                   limited); interactive reading material, same rationale as
//                   ai-models.
//   connect-public-mcp
//                   explicitly connects to Exa's public MCP server; external
//                   service and rate limited, so keep it interactive.
//   connect-openapi-petstore
//                   calls Swagger's public Petstore OpenAPI deployment;
//                   external service, so keep it interactive.
//   secret-postman-echo
//                   calls Postman Echo to prove egress secret substitution;
//                   external service, so keep it interactive.

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
  "whoami",
  "list-projects",
  "ai-models",
  "exa-web-search",
  "connect-public-mcp",
  "connect-openapi-petstore",
  "secret-postman-echo",
]);

export const EXAMPLE_CASES: Record<string, ExampleCase> = {
  "describe-project": {
    assert: (result, { projectId }, expect) => {
      expect(result).toMatchObject({ projectId });
      const builtins = (result as { builtins: string[] }).builtins;
      expect(builtins).toEqual(
        expect.arrayContaining(["streams", "repo", "workers", "secrets", "ai"]),
      );
      const children = (result as { children: string[] }).children;
      expect(children).toEqual(expect.arrayContaining(["capabilityHost", "integrations"]));
    },
  },
  "discover-tree": {
    assert: (result, _ctx, expect) => {
      const shaped = result as {
        integrationsChildren: Record<string, string>;
        rootChildren: Record<string, string>;
        scope: string;
      };
      expect(shaped.scope).toBe("/");
      expect(Object.keys(shaped.rootChildren)).toEqual(
        expect.arrayContaining(["capabilityHost", "capabilityHosts", "streams"]),
      );
      expect(Object.keys(shaped.integrationsChildren)).toEqual(
        expect.arrayContaining(["gmail", "slack"]),
      );
    },
  },
  "append-and-read-stream": {
    vars: ({ marker }) => ({ note: marker, path: `/repl/demo-${marker}` }),
    assert: (result, { marker }, expect) => {
      expect(result).toMatchObject({
        appended: {
          payload: { note: marker },
          type: "events.iterate.repl/demo",
        },
      });
      expect((result as { count: number }).count).toBeGreaterThan(0);
    },
  },
  "run-script": {
    assert: (result, { projectId }, expect) => {
      expect(result).toEqual({
        completedEventType: "events.iterate.com/capability-host/script-execution-completed",
        result: { projectId, sum: 42 },
      });
    },
  },
  "provide-live-capability": {
    assert: (result, _ctx, expect) => {
      expect(result).toEqual({
        deep: { answer: 42, question: "life, the universe, everything" },
        revoked: true,
        ultimate: 42,
      });
    },
  },
  "provide-live-flattened": {
    assert: (result, _ctx, expect) => {
      expect(result).toEqual({
        args: [{ channel: "C123", text: "hi" }],
        method: "chat.postMessage",
        provider: "live-session",
      });
    },
  },
  "provide-itx-expression": {
    vars: ({ marker }) => ({ note: marker, path: `/repl/expression-${marker}` }),
    assert: (result, { marker }, expect) => {
      expect(result).toMatchObject({ mountType: "itx-expression", note: marker });
      expect((result as { offset: number }).offset).toBeGreaterThan(0);
    },
  },
  "dynamic-worker-stateless": {
    assert: (result, _ctx, expect) => {
      expect(result).toEqual({ greeting: "hello, world", sum: 5 });
    },
  },
  "dynamic-worker-stateful": {
    // A fresh durable key per run makes the two increments deterministic.
    vars: ({ marker }) => ({ counterKey: `counter-${marker}` }),
    assert: (result, _ctx, expect) => {
      expect(result).toEqual({ current: 2 });
    },
  },
  "sandbox-exec": {
    // One shared sandbox path for the whole matrix: the first runtime pays
    // the container cold boot, the rest reuse the warm container (repeat
    // ensureProjectRepo calls are idempotent). No marker on purpose.
    vars: () => ({ sandboxPath: "/sandboxes/cloudflare/example-matrix" }),
    assert: (result, _ctx, expect) => {
      expect(result).toMatchObject({ exitCode: 0, os: "Linux" });
      expect((result as { repoFiles: string[] }).repoFiles).toEqual(
        expect.arrayContaining(["README.md", "worker.js"]),
      );
    },
  },
  "repo-commit-files": {
    // Unique content per run so the commit is never a no-op on the shared
    // matrix project.
    vars: ({ marker }) => ({ note: marker }),
    assert: (result, _ctx, expect) => {
      expect(result).toEqual({
        branch: "main",
        changedPaths: ["notes/example.md"],
        noChanges: false,
      });
    },
  },
  "repo-read-file": {
    assert: (result, _ctx, expect) => {
      expect(result).toMatchObject({
        exists: true,
        path: "README.md",
      });
      expect((result as { commitOid: string; preview: string }).commitOid).toMatch(/^[0-9a-f]+$/);
      expect((result as { preview: string }).preview.length).toBeGreaterThan(0);
    },
  },
  "repo-edit-file": {
    vars: ({ marker }) => ({
      path: "notes/edit-example.md",
      repoPath: `/examples/repo-edit-file-${marker}`,
    }),
    assert: (result, _ctx, expect) => {
      expect(result).toEqual({
        before: "# Edit example\n\nstatus: draft\n",
        after: "# Edit example\n\nstatus: reviewed\n",
        changedPaths: ["notes/edit-example.md"],
        occurrenceCount: 1,
      });
    },
  },
  "secrets-lifecycle": {
    vars: ({ marker }) => ({ note: marker, secretPath: `/secrets/example-${marker}` }),
    assert: (result, _ctx, expect) => {
      expect(result).toMatchObject({
        egress: { urls: ["https://postman-echo.com/"] },
        hasMaterial: true,
      });
      // The material must never appear in metadata.
      expect(JSON.stringify(result)).not.toContain("demo-");
    },
  },
  "journal-is-the-record": {
    vars: ({ marker }) => ({ capPath: `journal_${marker.replace(/-/g, "_")}` }),
    assert: (result, _ctx, expect) => {
      expect(result).toEqual({ record: ["capability-provided", "capability-revoked"] });
    },
  },
  "browse-examples": {
    assert: (result, _ctx, expect) => {
      expect(result).toMatchObject({ hasCode: true, id: "describe-project" });
      expect((result as { count: number }).count).toBeGreaterThan(10);
    },
  },
  "agent-send-message": {
    vars: ({ marker }) => ({
      agentPath: `/agents/example-${marker}`,
      message: `hello ${marker}`,
    }),
    assert: (result, { marker }, expect) => {
      expect(result).toMatchObject({
        payload: { content: `hello ${marker}`, origin: "web" },
        type: "events.iterate.com/agents/user-message-received",
      });
      expect((result as { offset: number }).offset).toBeGreaterThan(0);
    },
  },
};
