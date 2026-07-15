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
// The function body executes in a server-side isolate, so it must be
// self-contained: closures over test-file variables break at runtime. Pass
// values through `.vars({...})` — they are serialized into the script source
// and arrive as the function's second parameter.

import type { CapabilityHost, Project } from "../../src/itx-api.generated.ts";

/** Anything that can run an `async (itx) => …` script: `project.capabilityHost`,
 * `agent.capabilityHost`, or `itx.capabilityHosts.get(path)`. */
export type RunScriptHost = Pick<CapabilityHost, "runScript">;

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
   * dynamic capability the test mounted, or an agent scope's members. */
  context<NewCtx, Mode extends "extend" | "replace" = "extend">() {
    return this as unknown as ItxScriptBuilder<Mode extends "extend" ? Ctx & NewCtx : NewCtx, Vars>;
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
    return {
      code: [
        "async (itx) => {",
        `  const vars = ${JSON.stringify(this.scriptVars)};`,
        `  return await (${fn.toString()})(itx, vars);`,
        "}",
      ].join("\n"),
      $ctx: {} as Ctx,
      $type: {} as Result,
    };
  }

  async execute<Result>(fn: (itx: Ctx, vars: Vars) => Promise<Result>) {
    const defined = this.define(fn);
    const execution = await this.host.runScript(defined.code);
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
