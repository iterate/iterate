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
  async run(code: string): Promise<JsonValue | undefined> {
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
      ref: scriptWorkerRef({ code, scopePath }),
    });
    return result === undefined ? undefined : (JSON.parse(JSON.stringify(result)) as JsonValue);
  }
}

function scriptWorkerRef(input: { code: string; scopePath: string }): StatelessDynamicWorkerRef {
  const source = `
    import { WorkerEntrypoint } from "cloudflare:workers";
    const fn = ${input.code};
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
  // project workers and provided stateless capabilities; ITX adds only the
  // journal events. `bundle: false` over plain JavaScript is the loader-ready
  // fast path in resolveWorkerSource: scripts run on every agent turn and must
  // not pay a build round trip.
  return {
    path: input.scopePath,
    source: {
      files: {
        files: { "main.js": source },
        type: "inline",
      },
      options: { bundle: false, entryPoint: "main.js" },
    },
    entrypoint: "ScriptEntrypoint",
    type: "stateless",
  };
}
