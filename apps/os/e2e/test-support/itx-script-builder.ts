// Revived from Misha Kaletsky's hand-written CodemodeBuilder
// (e2e/test-support/codemode-builder.ts, pre-itx; deleted in #1447 "codemode
// rip, part 3" only because the codemode DOMAIN died — the design outlived
// it). Same define/execute/.success() ergonomics, adapted to the itx run
// surface: tests write a REAL typed TypeScript function (typechecked and
// refactorable in the test file), `.toString()` turns it into the script
// source, `execute()` runs it server-side through `capabilityHost.runScript`
// (journaled on the scope stream), and `.success()` hands back the
// strongly-typed result.
//
// THIS IS THE STANDARD WAY TO AUTHOR itx SCRIPTS IN TESTS. Typed `execute()`
// (or `define()` when the source is appended elsewhere) is the default door:
// the script is real TypeScript, so typos are compile errors and refactors
// reach into script bodies. `executeSource()`/`defineSource()` are the
// deliberate string siblings, ONLY for scripts that must stay strings —
// malformed-input and typecheck-gate tests, fence-extraction repros,
// replaying agent-authored text. Raw `host.runScript(...)` template strings
// outside this builder should not appear in new tests.
//
// The function body executes in a server-side isolate, so it must be
// self-contained: closures over test-file variables break at runtime — and
// so does any syntax the test-file transform downlevels into module-scope
// helpers (`using` becomes a `__vite_ssr_import_…` reference that only
// exists in the test isolate). `define()` rejects those at call time; the
// `iterate/itx-script-fn-self-contained` lint rule catches them at edit
// time. Pass values through `.vars({...})` — they are serialized into the
// script source and arrive as the function's second parameter.
//
// Future direction (deliberate, not yet built): deriving script source from
// the typed function's ORIGINAL source text (not `Function.prototype.
// toString` on transformed output) would be strictly better — no transform
// artifacts at all — and genuinely generating scripts from the type graph is
// the end state. `apps/os/scripts/generate-itx-examples.ts` (the examples
// catalogue generator) is the first step on that path.

import type { CapabilityHost, Project } from "../../src/itx-api.generated.ts";

/** Anything that can run an `async (itx) => …` script: `project.capabilityHost`,
 * `agent.capabilityHost`, or `itx.capabilityHosts.get(path)`. */
export type RunScriptHost = Pick<CapabilityHost, "runScript">;
export type RunScriptOptions = Exclude<Parameters<RunScriptHost["runScript"]>[1], undefined>;

/** A typed script builder against one capability-host scope. The default
 * script-side `itx` surface is the project handle; widen it for dynamic
 * capabilities with `.context<...>()`. */
export function itxScript(host: RunScriptHost) {
  return new ItxScriptBuilder<Project, {}>(host, {});
}

export class ItxScriptBuilder<Ctx, Vars extends Record<string, unknown>> {
  constructor(
    readonly host: RunScriptHost,
    readonly scriptVars: Vars,
  ) {}

  /** Type-only: extend (or replace) the script-side `itx` surface — e.g. a
   * dynamic capability the test mounted, or an agent scope's members. The
   * widening intersects FIRST (`NewCtx & Ctx`) so its call signatures win
   * overload resolution — that is what lets a test re-type a method-returned
   * handle (`agents.get(path): Agent & { someMount: … }`). */
  context<NewCtx, Mode extends "extend" | "replace" = "extend">() {
    return this as unknown as ItxScriptBuilder<Mode extends "extend" ? NewCtx & Ctx : NewCtx, Vars>;
  }

  /** Serialize values into the script source; they arrive as the function's
   * second parameter. The only sound way to get test-file values in — the
   * function cannot close over them. */
  vars<NewVars extends Record<string, unknown>>(vars: NewVars) {
    return new ItxScriptBuilder<Ctx, Vars & NewVars>(this.host, { ...this.scriptVars, ...vars });
  }

  /** The exact `async (itx) => …` source `execute()` would run, plus phantom
   * types — inspectable (and appendable elsewhere) without executing. */
  define<Result>(fn: (itx: Ctx, vars: Vars) => Promise<Result>) {
    const source = fn.toString();
    assertSelfContainedScriptSource(source);
    return {
      code: wrapScriptSource(source, this.scriptVars),
      $ctx: {} as Ctx,
      $type: {} as Result,
    };
  }

  /**
   * String sibling of `define()`: takes the function SOURCE as raw text — a
   * full `async (itx) => …` / `async (itx, vars) => …` function expression,
   * the same grammatical object `define()` receives as a value — and wraps
   * it exactly the way `define()` wraps `fn.toString()` (same vars preamble,
   * same `return await (<source>)(itx, vars)` envelope). For scripts that
   * must stay strings: deliberately malformed input, replayed agent text,
   * fence repros. Everything else should use the typed `define()`.
   */
  defineSource<Result = unknown>(code: string) {
    return {
      code: wrapScriptSource(code, this.scriptVars),
      $ctx: {} as Ctx,
      $type: {} as Result,
    };
  }

  async execute<Result>(fn: (itx: Ctx, vars: Vars) => Promise<Result>, options?: RunScriptOptions) {
    return await this.#run<Result>(this.define(fn).code, options);
  }

  /**
   * String sibling of `execute()`: runs a raw function-expression source
   * through the same envelope, with `.success()` typed by the explicit
   * generic (there is no function to infer from). Same result shape as
   * `execute()`.
   */
  async executeSource<Result = unknown>(code: string, options?: RunScriptOptions) {
    return await this.#run<Result>(this.defineSource<Result>(code).code, options);
  }

  async #run<Result>(code: string, options?: RunScriptOptions) {
    const execution = await this.host.runScript(code, options);
    return {
      /** Raw envelope from `runScript` (completedEvent, executionId, result). */
      execution,
      /**
       * The strongly-typed result. `runScript` already rejects when the script
       * errors (execute() throws before you get here), so this is the typed
       * door to a successful run's value — kept as a method for parity with
       * the original builder's assert-and-return shape.
       */
      success: () => execution.result as Result,
    };
  }
}

function wrapScriptSource(source: string, vars: Record<string, unknown>): string {
  return [
    "async (itx) => {",
    `  const vars = ${JSON.stringify(vars)};`,
    `  return await (${source})(itx, vars);`,
    "}",
  ].join("\n");
}

/**
 * Host-free door to `define()`: type-check and stringify a script for
 * channels that carry script SOURCE somewhere else — agent chat fences,
 * synthesized output events — instead of executing it against a host here.
 * Same vars and self-containment contract as `execute()`.
 */
export function defineItxScript<
  Ctx = Project,
  Vars extends Record<string, unknown> = Record<string, never>,
>(fn: (itx: Ctx, vars: Vars) => Promise<unknown>, vars?: Vars) {
  return new ItxScriptBuilder<Ctx, Vars>(defineOnlyHost, (vars ?? {}) as Vars).define(fn);
}

const defineOnlyHost: RunScriptHost = {
  runScript() {
    throw new Error("defineItxScript() carries source only — use itxScript(host) to execute.");
  },
};

/**
 * Markers the test-file transform leaves in `fn.toString()` when it had to
 * DOWNLEVEL syntax into module-scope helpers. Those helpers exist only in
 * the test isolate — shipped to the server-side script isolate, the first
 * touch throws `__vite_ssr_import_2__ is not defined`. Verified against the
 * current toolchain (vite 8 / oxc, 2026-07-15): a `using` declaration
 * compiles to `var _usingCtx = (0, __vite_ssr_import_2__.default)()`. The
 * `__using(`/`__async(`/`__await(` forms are esbuild's spellings of the same
 * helpers, kept so a toolchain swap fails loudly here instead of server-side.
 */
// Identifier-boundary matches (not bare substrings): a lookbehind rejects a
// preceding identifier character so e.g. a user variable `not_usingCtx` or a
// string literal mentioning these names mid-word never false-positives.
const TRANSFORM_HELPER_MARKERS = [
  /(?<![\w$])__vite_ssr_import_/,
  /(?<![\w$])_usingCtx(?![\w$])/,
  /(?<![\w$])__using\s*\(/,
  /(?<![\w$])__async\s*\(/,
  /(?<![\w$])__await\s*\(/,
] as const;

function assertSelfContainedScriptSource(source: string): void {
  const marker = TRANSFORM_HELPER_MARKERS.find((needle) => needle.test(source));
  if (!marker) return;
  throw new Error(
    `itxScript function is not self-contained: its compiled source matches the ` +
      `transform-helper pattern ${String(marker)}. The function ships as compiled JavaScript into a ` +
      `server-side isolate where only \`itx\`, \`vars\`, and runtime globals exist — ` +
      `module-scope helpers injected by the test-file transform (e.g. for \`using\` ` +
      `declarations) do not. Rewrite without the downleveled syntax (try/finally or an ` +
      `explicit [Symbol.dispose]() call), or — when the syntax itself is the point, like ` +
      `a \`using\` pipelining idiom — send the script as a string via executeSource(): ` +
      `the server runtime supports it natively, only the test-file transform downlevels ` +
      `it. Pass test-file values through .vars({...}).\n\nCompiled source:\n${source}`,
  );
}
