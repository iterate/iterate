// The catalogue typecheck guard: every generated example body, wrapped in
// the run-script envelope and typed per its `context`, is compiled against
// the real itx type graph with the REAL tswasm compiler — the same machinery
// the pre-execution gate and the docs door use (domains/typecheck). This is
// the only net the `e2eProven: false` entries have (they get no runtime
// proof), and it holds the generated artifact itself to the surface — a
// generator bug or a drifted escape-hatch string fails here.
//
// Three tiers, every entry passing all that apply:
// 1. NAME RESOLUTION (every entry, no exceptions): no "Cannot find name" —
//    a body referencing anything beyond `itx`, `vars`, and runtime globals
//    is a module-scope capture or a local typo; both are broken in every
//    runtime.
// 2. EXECUTION GATE (every entry, no exceptions): checkItxScriptForExecution
//    must return a `clean` verdict — no catalogue script may be one the
//    platform's own gate would refuse to run.
// 3. ADVISORY-CLEAN (the default): checkItxScript with the entry's dynamic
//    mounts declared must report NO problems. Entries where the PUBLISHED
//    surface provably cannot express the body are excused from this tier
//    only, each with its reason in SURFACE_GAPS — never a blanket skip.
import { createCompiler } from "tswasm";
import { beforeAll, test } from "vitest";
import type { CapabilityDescription } from "../domains/itx/describe.ts";
import type { CompileFn } from "../domains/typecheck/run-typecheck.ts";
import { runTypecheck } from "../domains/typecheck/run-typecheck.ts";
import {
  checkItxScript,
  checkItxScriptForExecution,
  type Typechecker,
} from "../domains/typecheck/virtual-project.ts";
import { ITX_EXAMPLES, type ItxExample } from "./examples.ts";

let typechecker: Typechecker;

beforeAll(async () => {
  const compiler = await createCompiler();
  typechecker = {
    check: (input) =>
      runTypecheck({
        compiler: compiler as CompileFn,
        // Bodies are plain JS with no imports, so nothing should acquire npm
        // types; if something tries, acquisition degrades to a note and the
        // real diagnostics still decide.
        fetchImpl: async () => new Response("not found", { status: 404 }),
        files: input.files,
        entrypoint: input.entrypoint,
      }),
  };
}, 120_000);

test.for(ITX_EXAMPLES.map((example) => ({ id: example.id, example })))(
  "example $id typechecks against the itx surface",
  { timeout: 60_000 },
  async ({ example }, { expect }) => {
    const code = runScriptEnvelope(example);
    const capabilities = EXAMPLE_MOUNTS[example.id] ?? contextMounts(example);

    // Tier 1+3: the advisory door reports everything it can see.
    const problems = await checkItxScript({ capabilities, code, typechecker });
    const nameMisses = problems.filter((problem) => /Cannot find name/.test(problem));
    expect(nameMisses, "bodies must be self-contained (itx, vars, globals only)").toEqual([]);

    const gapReason = SURFACE_GAPS[example.id];
    if (gapReason === undefined) {
      expect(problems).toEqual([]);
    } else {
      // The gap must be real: an excused entry that compiles clean means the
      // surface caught up and the excuse should be deleted.
      expect(problems, `SURFACE_GAPS says: ${gapReason} — but the entry is clean now`).not.toEqual(
        [],
      );
    }

    // Tier 2: the platform's own pre-execution gate must let every catalogue
    // script run — including the excused ones (the gate is permissive
    // exactly where the surface lags the runtime).
    const gate = await checkItxScriptForExecution({ capabilities, code, typechecker });
    expect(gate).toMatchObject({ verdict: "clean" });
  },
);

/**
 * The run-script envelope, typed. The runtime wraps a body as
 * `async (itx) => { const vars = {…}; <body> }` with the caller's actual
 * vars serialized in; the guard types `vars` loosely (Record<string, any>)
 * because entries' vars SHAPES are already typechecked where they are
 * authored (examples-source.ts) — here the subject is the body against the
 * itx surface.
 */
function runScriptEnvelope(example: ItxExample): string {
  return `async (itx) => {\nconst vars: Record<string, any> = {};\n${example.code}\n}`;
}

/** Session entries run against the OS Session, project/agent entries against
 * a project itx. checkItxScript always types `itx` as Project & mounts, so
 * agent entries declare the agent-scope members as typed mounts — exactly
 * what they are at runtime. */
function contextMounts(example: ItxExample): CapabilityDescription[] {
  if (example.context !== "agent") return [];
  return [
    mount(["chat"], "export type Chat = AgentChat;"),
    mount(["agent"], "export type AgentSurface = Agent;"),
    mount(["workspace"], "export type AgentWorkspace = Workspace;"),
  ];
}

/** Dynamic capabilities individual entries provide and then call — declared
 * to the checker the same way a real provide-time `types` field would be. */
const EXAMPLE_MOUNTS: Record<string, CapabilityDescription[]> = {
  "provide-live-capability": [
    mount(
      ["answer"],
      "export type Answer = { ultimate(): Promise<number>; deep: { thought(question: string): Promise<{ answer: number; question: string }> } };",
    ),
  ],
  "provide-live-flattened": [
    mount(
      ["fakeSlack"],
      "export type FakeSlack = { chat: { postMessage(message: { channel: string; text: string }): Promise<unknown> } };",
    ),
  ],
  "provide-itx-expression": [mount(["demoStream"], "export type DemoStream = Stream;")],
  "exa-web-search": [
    mount(
      ["mcp", "exa"],
      "export type ExaTools = { web_search_exa(input: { query: string; numResults?: number }): Promise<unknown>; web_fetch_exa(input: { urls: string[]; maxCharacters?: number }): Promise<unknown> };",
    ),
  ],
};

/**
 * Entries excused from tier 3 (advisory-clean) ONLY — each because the
 * PUBLISHED type surface cannot express what the body genuinely does at
 * runtime. Every one still passes name resolution and the execution gate.
 * When a surface gap closes (the generated types catch up), the entry
 * compiles clean and this test FAILS until its excuse is removed.
 */
const SURFACE_GAPS: Record<string, string> = {
  whoami:
    "Session-context: checkItxScript types itx as Project; the Session shape (principal on __describe) " +
    "is typechecked where it is authored, in examples-source.ts",
  "list-projects":
    "Session-context (itx.projects is a Session member), plus capnweb pipelining — __describe() on the " +
    "un-awaited Promise<Project> from projects.get()",
  "connect-public-mcp":
    "capnweb pipelining: a dynamically-named tool call on the un-awaited Promise<McpClientRpc> from " +
    "mcp.connect(); tool names only exist server-side",
  "connect-openapi-petstore":
    "capnweb pipelining: operationIds are methods on the un-awaited Promise<OpenApiRpc> from " +
    "openapi.connect(); the spec's operations only exist at runtime",
  "dynamic-worker-stateless":
    "workers.get() returns DynamicWorkerCapability<Record<string, unknown>> — the worker's own methods " +
    "(hello/add) are typed per entry in examples-source.ts, not in the published surface",
  "dynamic-worker-stateful":
    "same as dynamic-worker-stateless: increment()/current() live on the entry's worker, not the surface",
  "github-read-file":
    "the sidecar's compiler-only structural Octokit shim types request() as Promise<unknown> (the real " +
    "octokit package graph is too large for the in-Worker checker); readme.data is typed in " +
    "examples-source.ts against the real Octokit",
  "gmail-search-inbox":
    "GmailConnection.request's data is caller-typed (request<T = unknown>); this plain-JS body " +
    "cannot instantiate T and reads list/get resources dynamically — its shapes are declared in " +
    "examples-source.ts",
  "ai-generate-text":
    "ai.run's output is caller-typed (run<T = unknown>); this plain-JS body cannot instantiate T " +
    "and reads result.response — the shape is declared in examples-source.ts",
  "ai-generate-image": "same run<T> constraint as ai-generate-text; the body reads response.image",
  "ai-generate-audio": "same run<T> constraint as ai-generate-text; the body reads result.audio",
  "ai-transcribe-audio":
    "same run<T> constraint as ai-generate-text; the body reads result.text and friends",
  "ai-generate-video": "same run<T> constraint as ai-generate-text; the body reads result.video",
  "cf-browser-markdown":
    "browser.quickAction() returns the action-shaped unknown; markdown is a string per entry",
};

function mount(path: string[], types: string): CapabilityDescription {
  return { path, type: "itx-expression", types };
}
