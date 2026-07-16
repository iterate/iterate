import { tracing, WorkerEntrypoint } from "cloudflare:workers";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import type { JsonValue } from "../workers/schemas.ts";
import {
  DYNAMIC_WORKER_COMPATIBILITY_DATE,
  DYNAMIC_WORKER_COMPATIBILITY_FLAGS,
} from "../workers/worker-runtime-configuration.ts";
import { stableSha256 } from "../workers/utils.ts";

type ScriptExecutorEnv = {
  CAPABILITY_HOST: DurableObjectNamespace;
  LOADER: WorkerLoader;
  PROJECT: DurableObjectNamespace;
};

/**
 * The authority a capability host lends to one script execution.
 *
 * Only durable coordinates cross from the host. The executor mints stable DO
 * stubs from its cross-script namespaces, so neither a native ServiceStub nor
 * a non-persistent incoming RpcStub has to be forwarded through Workers RPC.
 */
export type ScriptExecutionAuthority = {
  ownerWorkerName: string;
  projectId: string;
  scopePath: string;
};

export type ScriptExecutorRunInput = {
  authority: ScriptExecutionAuthority;
  code: string;
  /** Typechecker output whose default export is the script function. */
  emittedJs?: string;
};

/**
 * Small, dedicated loader owner for itx scripts.
 *
 * CapabilityHostDurableObject owns the durable request/started/completed
 * journal. This stateless sidecar owns only Dynamic Worker load + invocation,
 * so every concurrent script receives an independent loader-owning request
 * without cold-starting the full OS application bundle.
 */
export class ScriptExecutorEntrypoint extends WorkerEntrypoint<ScriptExecutorEnv> {
  override fetch(): Response {
    return Response.json({ worker: "os-script-executor" }, { status: 404 });
  }

  async run(input: ScriptExecutorRunInput): Promise<JsonValue | undefined> {
    return tracing.enterSpan("dynamic_worker.run_script.call", async (span) => {
      span.setAttribute("iterate.worker.kind", "run_script");
      span.setAttribute("iterate.worker.operation", "call");
      span.setAttribute("iterate.worker.source", "inline");
      span.setAttribute("iterate.worker.type", "stateless");

      const modules = scriptWorkerModules(input);
      const sourceHash = await stableSha256({
        mainModule: "main.js",
        modules,
        type: "itx-script",
      });
      const cacheKey = [
        "script-executor",
        input.authority.ownerWorkerName,
        input.authority.projectId,
        input.authority.scopePath,
        sourceHash,
      ].join(":");
      const capabilityHost = this.env.CAPABILITY_HOST.getByName(
        DurableObjectNameCodec.stringify({
          path: input.authority.scopePath,
          projectId: input.authority.projectId,
        }),
      );
      const globalOutbound = this.env.PROJECT.getByName(
        DurableObjectNameCodec.stringify({ path: "/", projectId: input.authority.projectId }),
      ) as unknown as Fetcher;
      const worker = this.env.LOADER.get(cacheKey, () => ({
        compatibilityDate: DYNAMIC_WORKER_COMPATIBILITY_DATE,
        compatibilityFlags: DYNAMIC_WORKER_COMPATIBILITY_FLAGS,
        env: { ITX_HOST: capabilityHost },
        globalOutbound,
        mainModule: "main.js",
        modules,
      }));
      const entrypoint = worker.getEntrypoint("ScriptEntrypoint", { props: {} }) as unknown as {
        run(): Promise<unknown>;
      };
      const result = await entrypoint.run();
      return result === undefined ? undefined : (JSON.parse(JSON.stringify(result)) as JsonValue);
    });
  }
}

function scriptWorkerModules(
  input: Pick<ScriptExecutorRunInput, "code" | "emittedJs">,
): Record<string, string> {
  // Preferred shape: run the gate's emitted module. When the permissive gate
  // was skipped or could not emit, embed the raw expression so ordinary
  // JavaScript still runs and TypeScript-only syntax fails explicitly in the
  // loader rather than being silently rewritten.
  const importLine = input.emittedJs === undefined ? "" : `import scriptModule from "./script.js";`;
  const fnSource = input.emittedJs === undefined ? input.code : "scriptModule";
  const main = `
    import { WorkerEntrypoint } from "cloudflare:workers";
    ${importLine}
    const fn = ${fnSource};
    export class ScriptEntrypoint extends WorkerEntrypoint {
      async run() {
        using itx = await this.env.ITX_HOST.getItxForScript();
        return await fn(itx);
      }
    }
  `;
  return input.emittedJs === undefined
    ? { "main.js": main }
    : { "main.js": main, "script.js": input.emittedJs };
}
