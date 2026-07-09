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
//   cf-ai-to-markdown
//                   depends on Cloudflare Workers AI Markdown Conversion;
//                   interactive reading material, same rationale as ai-models.
//   ai-generate-image
//   ai-generate-audio
//   ai-transcribe-audio
//   ai-generate-video
//                   depend on remote Workers AI/Gateway model availability,
//                   latency, and billing; interactive reading material.
//   cf-browser-markdown
//                   depends on Browser Run and a public docs page; external
//                   service, so keep it interactive.
//   cf-images-transform
//                   depends on the Images binding and a public image fetch;
//                   external service, so keep it interactive.
//   cf-videos-frame depends on the Media Transformations binding and a public
//                   video fetch; external service, so keep it interactive.
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
//   email-send      sends real outbound mail through Cloudflare Email Service;
//                   needs an onboarded sender domain and a real recipient
//                   mailbox, so keep it interactive.

export type ExampleRunContext = {
  /** Unique per example × runtime, for stream/event payload assertions. */
  marker: string;
  projectId: string;
};

export type ExampleCase = {
  vars?: (ctx: ExampleRunContext) => Record<string, unknown>;
  assert: (result: unknown, ctx: ExampleRunContext, expect: typeof import("vitest").expect) => void;
  /**
   * Completion budget (ms) for runners whose default is tighter. Cold-path
   * examples (a fresh sandbox container per fixture project) legitimately take
   * tens of seconds; that is expected latency, not a hang.
   */
  completionTimeoutMs?: number;
};

/** Example ids that intentionally have no matrix case (see header). */
export const EXAMPLE_IDS_WITHOUT_CASES = new Set([
  "whoami",
  "list-projects",
  "ai-models",
  "cf-ai-to-markdown",
  "ai-generate-image",
  "ai-generate-audio",
  "ai-transcribe-audio",
  "ai-generate-video",
  "cf-browser-markdown",
  "cf-images-transform",
  "cf-videos-frame",
  "exa-web-search",
  "connect-public-mcp",
  "connect-openapi-petstore",
  "secret-postman-echo",
  "github-mcp-connect",
  "github-webhooks-project-worker",
  // Built-in integration usage snippets: each needs a REAL connected
  // GitHub/Google/Slack account, which e2e fixture projects never hold.
  "github-list-repos",
  "github-read-file",
  "github-backed-repo",
  "gmail-search-inbox",
  "slack-post-message",
  "email-send",
]);

export const EXAMPLE_CASES: Record<string, ExampleCase> = {
  "stream-cross-post": {
    // Matrix runtimes share a project; per-runtime paths keep the cross-post
    // subscription and its copies from colliding with a sibling runtime's.
    vars: ({ marker }) => ({
      source: `/examples/cross-post/source-${marker}`,
      target: `/examples/cross-post/target-${marker}`,
    }),
    assert: (result, ctx, expect) => {
      const shaped = result as {
        copied: { importance: string; text: string };
        provenance: Array<{ subscriptionKey: string }>;
      };
      expect(shaped.copied).toMatchObject({ importance: "high", text: "copied" });
      expect(shaped.provenance).toHaveLength(1);
      // crossPostTo without an explicit key defaults to cross-post:<target>.
      expect(shaped.provenance[0]).toMatchObject({
        subscriptionKey: `cross-post:/examples/cross-post/target-${ctx.marker}`,
      });
    },
  },
  "scheduler-basics": {
    // Matrix runtimes can share a project; a per-runtime key keeps the
    // set/list/cancel dance from racing a sibling runtime's copy.
    vars: ({ marker }) => ({ schedulerKey: `examples/daily-report-${marker}` }),
    assert: (result, _ctx, expect) => {
      const shaped = result as { found: boolean; nextTriggerAt: string | null };
      expect(shaped.found).toBe(true);
      // Next weekday 9am London is always a parseable future instant.
      expect(Date.parse(shaped.nextTriggerAt ?? "")).toBeGreaterThan(Date.now());
    },
  },
  "scheduler-agent-checkin": {
    vars: ({ marker }) => ({ schedulerKey: `examples/agent-checkin-${marker}` }),
    assert: (result, _ctx, expect) => {
      // { every: 3600 } anchored at set time: the next occurrence is ahead.
      const shaped = result as { nextTriggerAt: string | null };
      expect(Date.parse(shaped.nextTriggerAt ?? "")).toBeGreaterThan(Date.now());
    },
  },
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
      // The integrations collection's children are its management verbs;
      // per-connection call surfaces (slack/google/github) are dotted
      // dispatch, not member nodes — connections enumerate via list().
      expect(Object.keys(shaped.integrationsChildren)).toEqual(
        expect.arrayContaining(["list", "getConnection", "completeConnect"]),
      );
    },
  },
  "files-roundtrip": {
    vars: ({ marker }) => ({ note: `files ${marker}`, path: `/repl/files-${marker}.txt` }),
    assert: (result, { marker }, expect) => {
      const shaped = result as {
        servedStatus: number;
        servedText: string;
        size: number;
        text: string;
        url: string;
      };
      expect(shaped.text).toBe(`files ${marker}`);
      expect(shaped.servedStatus).toBe(200);
      expect(shaped.servedText).toBe(`files ${marker}`);
      expect(shaped.size).toBeGreaterThan(0);
      expect(shaped.url).toContain("iterate-files--");
      expect(shaped.url).toContain("sig=");
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
    // One shared sandbox name for the whole matrix: the first runtime pays
    // the create + container cold boot, the rest reuse the warm container
    // (the example's get-or-create makes reuse natural). No marker on
    // purpose. 300s: a cold-host image pull + boot has a long tail even on
    // the stock image; anything past that is a container stuck provisioning,
    // and we'd rather fail and re-run than mask it.
    completionTimeoutMs: 300_000,
    vars: () => ({ sandboxName: "example-matrix" }),
    assert: (result, _ctx, expect) => {
      expect(result).toMatchObject({ exitCode: 0, os: "Linux", marker: "hello" });
    },
  },
  "workspace-edit-and-push": {
    // Unique workspace per example × runtime: the path is durable identity
    // (one Durable Object, one branch), so sharing one across the matrix
    // would make the second runtime's edit() fail (oldString already
    // replaced) and pushes race. Each run pays its own clone — seconds, not
    // the sandbox's container boot — but the budget still covers a cold
    // Artifacts clone with the 503-retry tail.
    completionTimeoutMs: 120_000,
    vars: ({ marker }) => ({ workspacePath: `/workspaces/examples/edit-${marker}` }),
    assert: (result, ctx, expect) => {
      expect(result).toMatchObject({
        readmePresent: true,
        edited: { occurrenceCount: 1, path: "/notes/workspace-example.md" },
        pushedBranch: `workspaces/examples/edit-${ctx.marker}`,
      });
      expect((result as { commitOid: string }).commitOid).toMatch(/^[0-9a-f]{40}$/);
    },
  },
  "workspace-files-transfer": {
    // Fresh workspace per run (same identity reasoning as above); the files
    // paths are shared but every put() overwrites, and `note` makes each
    // run's transferred content self-identifying.
    completionTimeoutMs: 120_000,
    vars: ({ marker }) => ({
      note: `transfer-${marker}`,
      workspacePath: `/workspaces/examples/transfer-${marker}`,
    }),
    assert: (result, ctx, expect) => {
      expect(result).toMatchObject({
        inWorkspace: `transfer-${ctx.marker}`,
        published: {
          contentType: "application/json",
          path: "/examples/package-from-workspace.json",
        },
      });
      expect((result as { published: { size: number } }).published.size).toBeGreaterThan(0);
      expect((result as { urlHost: string }).urlHost).toContain("iterate-files--");
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
        payload: { content: `hello ${marker}`, from: { kind: "user", origin: "web" } },
        type: "events.iterate.com/agents/message-received",
      });
      expect((result as { offset: number }).offset).toBeGreaterThan(0);
    },
  },
};
