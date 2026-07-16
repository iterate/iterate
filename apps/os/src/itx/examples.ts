// The itx example catalogue: one data structure that is BOTH the "Examples"
// panel in the REPL UI and the script set the e2e suite runs across every
// execution runtime (apps/os/e2e/examples/*). Each entry is a self-contained
// script body that runs with `itx` and `vars` in scope and uses an explicit
// `return` — exactly the shape every runtime accepts:
//
//   browser         the REPL (compileBrowserReplFunction wraps the body)
//   node            AsyncFunction("itx", "vars", code) on a Cap'n Web stub
//   run-script      itx.capabilityHost.runScript(`async (itx) => { const vars = …; <body> }`)
//                   — the server-side script isolate agents use
//   project-worker  the body baked into the config repo's worker.ts,
//                   executed against `await this.env.ITX.get()`
//
// Almost every example is written against a PROJECT itx (context: "project"):
// the harness — a project REPL, connectItxBrowser({ projectId }), runScript, or a
// dynamic worker's env.ITX — is already scoped into the project, and the
// script gets straight to work: itx.streams.get("/some/path").append(...).
// Session-context examples run against the OS Session (what authenticate()
// returns) instead — a session vends project itxs; it is not itself an itx.
//
// `runtimes` records where a snippet genuinely works unattended. Live
// capabilities (provideCapability with a `capability` value) are session-bound
// — the provider object lives in the calling process — so those entries stay
// browser/node/cli only. Everything else must stay runtime-agnostic: no
// pipelining tricks, plain serializable return values.
//
// ENTRIES ARE NOT EDITED HERE: the catalogue is authored as TYPED FUNCTIONS
// in ./examples-source.ts (so bodies typecheck against the real itx surface)
// and the plain-JS `code` strings are generated from that file's original
// source text by scripts/generate-itx-examples.ts (`pnpm
// generate:itx-examples`, freshness-guarded by examples.generated.test.ts).
// This module is the stable import path: it owns the public types and
// re-exports the generated data, so the catalogue's consumers never touch
// the generated file directly.

export const ITX_EXAMPLE_RUNTIMES = [
  "browser",
  "node",
  "cli",
  "run-script",
  "project-worker",
] as const;

export type ItxExampleRuntime = (typeof ITX_EXAMPLE_RUNTIMES)[number];

export type ItxExample = {
  /** Script body: `itx` and `vars` in scope, explicit `return`. */
  code: string;
  /**
   * Whether the e2e matrix (apps/os/e2e/examples) proves this entry by
   * running it unattended across every runtime. `false` marks interactive
   * reading material — snippets that need a real connected account, a
   * remote model, or a Session context the matrix does not hold. Absent
   * means proven; the matrix derives its exclusion list from this field and
   * the docs door words its provenance claim from it.
   */
  e2eProven?: false;
  /** The handle the snippet expects: a project itx (the normal case), an
   * AGENT itx (the project surface plus the agent's own mounts — chat,
   * workspace, agent; the docs door serves these too since agents are its
   * main audience, but the unattended matrix skips them: they need a live
   * conversation), or the OS Session — what authenticate() returns, not an
   * itx (__describe / projects.list only). */
  context: "agent" | "project" | "session";
  description: string;
  id: string;
  /** Runtimes the snippet runs unattended in (the e2e matrix honors this). */
  runtimes: ItxExampleRuntime[];
  title: string;
};

export { ITX_EXAMPLES } from "./examples.generated.ts";
