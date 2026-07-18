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
//                   suites (apps/os/e2e/vitest/itx-core.e2e.test.ts).
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
//   ai-generate-text
//                   depends on remote Workers AI model availability and
//                   billing; interactive reading material.
//   egress-fetch    fetches a public website through project egress; external
//                   service, so keep it interactive.
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

import { ITX_EXAMPLES } from "../../src/itx/examples.ts";

export type ExampleRunContext = {
  /** Unique per example × runtime, for stream/event payload assertions. */
  marker: string;
  /**
   * Unique per test ATTEMPT. Cases that explicitly run their runtimes serially
   * also share one project, so this can name one warm resource across those
   * runtimes while a RETRY still gets a fresh placement.
   */
  attemptSalt: string;
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
  /**
   * Runtimes are independent and run concurrently by default. Use serial only
   * when they intentionally lease one exclusive external resource.
   */
  runtimeExecution?: "parallel" | "serial";
  /**
   * Post-assertion teardown, run by every runner with a project-scoped itx.
   * For examples that create real slot-level resources (sandbox containers):
   * back-to-back e2e runs otherwise accumulate instances until Cloudflare's
   * container provisioning throttles the whole slot into multi-minute boot
   * stalls (every 2026-07-10 marathon died on this around run 4-6, while
   * spaced-out PR runs never saw it). Best-effort — a cleanup failure logs,
   * never fails the test.
   */
  cleanup?: (itx: unknown, ctx: ExampleRunContext) => Promise<void>;
};

/** Example ids that intentionally have no matrix case: exactly the entries
 * the catalogue marks `e2eProven: false` (see the field's docstring — the
 * data is the single source; the per-id rationales live in the header
 * above). */
export const EXAMPLE_IDS_WITHOUT_CASES = new Set(
  ITX_EXAMPLES.filter((example) => example.e2eProven === false).map((example) => example.id),
);

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
      // Built-ins ARE the children map; `capabilities` holds dynamic mounts
      // only. The matrix shares one fixture project, so sibling examples may
      // have left durable mounts — assert the shape, not emptiness.
      const builtins = (result as { builtins: string[] }).builtins;
      expect(builtins).toEqual(
        expect.arrayContaining([
          "streams",
          "repo",
          "workers",
          "secrets",
          "ai",
          "capabilityHost",
          "integrations",
        ]),
      );
      const mounted = (result as { mounted: string[] }).mounted;
      expect(mounted.every((path) => typeof path === "string")).toBe(true);
      expect(mounted).not.toContain("streams"); // builtins never appear here
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
  "egress-rules-configured": {
    // .invalid is RFC 2606-reserved (never resolves) — the rule is never
    // actually matched against a real request here, only appended and read
    // back, so a real hostname would be misleading.
    vars: ({ marker }) => ({
      host: `example-${marker}.invalid`,
      ruleKey: `repl-demo-hold-${marker}`,
    }),
    assert: (result, { marker }, expect) => {
      expect(result).toMatchObject({
        host: `example-${marker}.invalid`,
        offset: expect.any(Number),
        ruleKey: `repl-demo-hold-${marker}`,
      });
    },
  },
  "ephemeral-events": {
    vars: ({ marker }) => ({ path: `/repl/ephemeral-demo-${marker}` }),
    assert: (result, _ctx, expect) => {
      const shaped = result as {
        tickOffset: number;
        defaultOffsets: number[];
        rawOffsets: number[];
      };
      // Consecutive offsets; the ephemeral tick is excluded from the default
      // read and present (flagged position first) in the raw read.
      expect(shaped.defaultOffsets).toEqual([shaped.tickOffset + 1]);
      expect(shaped.rawOffsets).toEqual([shaped.tickOffset, shaped.tickOffset + 1]);
    },
  },
  "run-script": {
    assert: (result, { projectId }, expect) => {
      expect(result).toEqual({
        completedEventType: "events.iterate.com/capability-host/script-run-settled",
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
    // (the example's get-or-create makes reuse natural), and the retry's
    // attemptSalt re-rolls the container placement. No marker on
    // purpose. 150s: a healthy cold boot is well under a minute; a boot
    // past this is a container stuck provisioning on a bad placement, and
    // the retry's FRESH attempt re-rolls placement and typically lands in
    // ~15s — waiting out a 300s budget just stretched both e2e lanes past
    // their watchdogs (2026-07-10 marathon j3tqdhncb6 run 2: one 5.1m boot
    // stalled the spec AND examples-matrix; the retry passed in 14.8s).
    completionTimeoutMs: 150_000,
    // Four runtimes intentionally lease one warm container for this attempt.
    // The sandbox is the bounded resource pool; serial access avoids four
    // simultaneous cold boots without throttling any unrelated example.
    runtimeExecution: "serial",
    vars: ({ attemptSalt }) => ({ sandboxName: `example-${attemptSalt}` }),
    assert: (result, _ctx, expect) => {
      expect(result).toMatchObject({ exitCode: 0, os: "Linux", marker: "hello" });
    },
    cleanup: async (itx, ctx) => {
      const project = itx as {
        sandboxes: { get(path: string): Promise<{ destroy(): Promise<unknown> }> };
      };
      const sandbox = await project.sandboxes.get(`/sandboxes/example-${ctx.attemptSalt}`);
      await sandbox.destroy();
    },
  },
  "workspace-edit-and-push": {
    // Unique workspace per example × runtime: the path is durable identity
    // (one Durable Object). Exclusive runtime project leases also keep the
    // config-repo commits from racing. The budget covers the repo commit lane's
    // cold tail.
    completionTimeoutMs: 120_000,
    vars: ({ marker }) => ({ workspacePath: `/workspaces/examples/edit-${marker}` }),
    assert: (result, _ctx, expect) => {
      expect(result).toMatchObject({
        readmePresent: true,
        edited: { occurrenceCount: 1, path: "/notes/workspace-example.md" },
      });
      const typed = result as {
        commitOid: string;
        committedMount: string;
        committedTo: string;
        status: { mounts: { changes: { path: string }[]; path: string }[] };
      };
      // #1831: commits land straight on the mounted repo's default branch —
      // there is no per-workspace branch. #2095: status groups changes by
      // owning mount, and the commit names the mount it was scoped to.
      expect(typed.committedTo).toMatch(/^\S+$/);
      expect(typed.commitOid).toMatch(/^[0-9a-f]{40}$/);
      expect(typed.committedMount).toBe("/");
      const rootMount = typed.status.mounts.find((mount) => mount.path === "/");
      expect(rootMount?.changes.map((change) => change.path)).toContain(
        "/notes/workspace-example.md",
      );
    },
  },
  "workspace-files-transfer": {
    // Fresh workspace and project-file paths per runtime also keep sequential
    // reuse of an exclusive runtime-family project independent.
    completionTimeoutMs: 120_000,
    vars: ({ marker }) => ({
      note: `transfer-${marker}`,
      publishedFilePath: `/examples/package-from-workspace-${marker}.json`,
      sourceFilePath: `/examples/transfer-${marker}.txt`,
      workspacePath: `/workspaces/examples/transfer-${marker}`,
    }),
    assert: (result, ctx, expect) => {
      expect(result).toMatchObject({
        inWorkspace: `transfer-${ctx.marker}`,
        published: {
          contentType: "application/json",
          path: `/examples/package-from-workspace-${ctx.marker}.json`,
        },
      });
      expect((result as { published: { size: number } }).published.size).toBeGreaterThan(0);
      expect((result as { urlHost: string }).urlHost).toContain("iterate-files--");
    },
  },
  "repo-commit-files": {
    // Unique content per run so sequential reuse of a runtime-family project
    // never turns this into a no-op.
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
  "docs-search-and-get": {
    assert: (result, _ctx, expect) => {
      expect(result).toMatchObject({
        examplePasteReady: true,
        streamTypesIncludeAppend: true,
      });
      expect((result as { hitCount: number }).hitCount).toBeGreaterThan(0);
      expect(result).toHaveProperty("firstHit.fetchCall");
    },
  },
  "typed-capability-mount": {
    assert: (result, _ctx, expect) => {
      expect(result).toEqual({
        searchFoundMount: true,
        entryIncludesStreamDeclaration: true,
        goodScriptOk: true,
        typoCaught: true,
      });
    },
  },
  "agent-send-message": {
    vars: ({ marker }) => ({
      agentPath: `/agents/example-${marker}`,
      message: `hello ${marker}`,
    }),
    assert: (result, { marker }, expect) => {
      expect(result).toMatchObject({
        payload: {
          role: "user",
          content: `hello ${marker}`,
          actor: { type: "user", origin: "web" },
        },
        type: "events.iterate.com/agents/context-added",
      });
      expect((result as { offset: number }).offset).toBeGreaterThan(0);
    },
  },
};
