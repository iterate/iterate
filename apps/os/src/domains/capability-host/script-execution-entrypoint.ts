import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "../../env.ts";
import type { JsonValue, StatelessDynamicWorkerRef } from "../workers/schemas.ts";
import { normalizePath } from "../durable-object-names.ts";
import { DynamicWorkerRunner } from "../workers/worker-runner.ts";

/**
 * Stateless loopback executor for capability-host runScript.
 *
 * The capability-host Durable Object journals script lifecycle events, but this
 * entrypoint owns the Dynamic Worker load and invocation. That keeps concurrent
 * script starts from sharing the DO as the Worker Loader owner.
 */
export class ScriptExecutionEntrypoint extends WorkerEntrypoint<
  Env,
  { projectId: string; scopePath: string }
> {
  async run(
    code: string,
    options?: {
      /**
       * The typecheck gate's emitted JavaScript for this script (its default
       * export is the script function) — check and emit are one compile, so
       * running the compiler's own output is what makes scripts genuinely
       * TypeScript. Absent when the gate was skipped or the sidecar was
       * unreachable: then `code` embeds raw, which still runs every
       * plain-JavaScript script and surfaces TS-only syntax as the loader's
       * error into the corrective-retry lane.
       */
      emittedJs?: string;
    },
  ): Promise<JsonValue | undefined> {
    const projectId = this.ctx.props.projectId;
    const scopePath = normalizePath(this.ctx.props.scopePath);
    const dynamicWorkers = new DynamicWorkerRunner({
      exports: this.ctx.exports,
      projectId,
      scopePath,
      waitUntil: (promise) => this.ctx.waitUntil(promise),
    });

    // Scripts execute inside THIS scope: the loaded worker's env.ITX resolves
    // to the same path the capability host owns.
    const result = await dynamicWorkers.invokeCapability({
      path: ["run"],
      ref: scriptWorkerRef({ code, emittedJs: options?.emittedJs, scopePath }),
      traceRole: "run_script",
    });
    return result === undefined ? undefined : (JSON.parse(JSON.stringify(result)) as JsonValue);
  }
}

function scriptWorkerRef(input: {
  code: string;
  emittedJs?: string;
  scopePath: string;
}): StatelessDynamicWorkerRef {
  // Preferred shape: the gate's emitted module (default export = the script
  // function) as its own file, imported by the harness — the compiler's
  // type-stripped output is what runs. Fallback shape (no emit available):
  // embed the raw code as an expression, exactly the pre-gate behavior.
  const scriptModule = input.emittedJs;
  const fnSource = scriptModule === undefined ? input.code : `scriptModule`;
  const importLine = scriptModule === undefined ? "" : `import scriptModule from "./script.js";`;
  const source = `
    import { WorkerEntrypoint } from "cloudflare:workers";
    ${importLine}
    const fn = ${fnSource};
    export class ScriptEntrypoint extends WorkerEntrypoint {
      async run() {
        // \`using\`: the itx root is an RPC stub this isolate owns for the
        // script's duration; releasing it on return (the result is fully
        // awaited by then) keeps the runtime's stub-disposal warning out of
        // the logs. Values the script obtained THROUGH it (returned stubs,
        // appended events) hold their own references and are unaffected.
        using itx = await this.env.ITX.get();
        return await fn(itx);
      }
    }
  `;
  // runScript is deliberately expressed as a stateless inline DynamicWorkerRef.
  // That keeps script execution on the same DynamicWorkerRunner dispatch path as
  // project workers and provided stateless capabilities; itx adds only the
  // journal events. `bundle: false` over plain JavaScript is the loader-ready
  // fast path in resolveWorkerSource: scripts run on every agent turn and must
  // not pay a build round trip.
  return {
    path: input.scopePath,
    source: {
      files: {
        files:
          scriptModule === undefined
            ? { "main.js": source }
            : { "main.js": source, "script.js": scriptModule },
        type: "inline",
      },
      options: { bundle: false, entryPoint: "main.js" },
    },
    entrypoint: "ScriptEntrypoint",
    type: "stateless",
  };
}
