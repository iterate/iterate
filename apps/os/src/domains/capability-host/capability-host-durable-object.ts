import { DurableObject } from "cloudflare:workers";
import { workerVersion, type Env } from "../../env.ts";
import type { CapabilityDescription } from "../itx/describe.ts";
import { trustedInternalAuthContext } from "../../auth.ts";
import { DurableObjectNameCodec, parentScopePath } from "../durable-object-names.ts";
import { createStreamProcessorHost } from "../streams/stream-processor-host.ts";
import type {
  StreamSubscriberWakeRequest,
  StreamSubscriberWakeResponse,
} from "../streams/rpc-types.ts";
import { StreamProcessorRpcTarget } from "../../rpc-targets.ts";
import { itxForScope, StreamRpcTarget } from "../../rpc-targets.ts";
import { checkCapabilityTypes, checkItxScriptForExecution } from "../typecheck/virtual-project.ts";
import {
  CapabilityHostProcessor,
  type ParentCapabilityHost,
  type RunScriptResult,
} from "./capability-host-processor-implementation.ts";
import type { ProvideCapabilityInput } from "./types.ts";

type ScriptExecutionEntrypoint = {
  run(code: string, options?: { emittedJs?: string }): Promise<unknown>;
};

type ScriptExecutionLoopbackExports = {
  ScriptExecutionEntrypoint(input: {
    props: {
      projectId: string;
      scopePath: string;
    };
  }): ScriptExecutionEntrypoint;
};

/**
 * One capability scope: the durable dynamic-capability table and script
 * journal at one `{projectId, path}`. `provideCapability` always mounts here;
 * `invokeCapability`/`describeCapabilities` chain up to the enclosing scope's
 * host on a local miss.
 */
export class CapabilityHostDurableObject extends DurableObject<Env> {
  readonly #name = DurableObjectNameCodec.parse(this.ctx.id.name!);
  readonly #processorHost = createStreamProcessorHost(this.ctx, {
    stream: new StreamRpcTarget({
      auth: trustedInternalAuthContext(),
      path: this.#name.path,
      projectId: this.#name.projectId,
    }),
    path: this.#name.path,
    projectId: this.#name.projectId,
    version: workerVersion(this.env),
  });
  readonly #capabilityHostProcessor = this.#processorHost.add(
    (deps) =>
      new CapabilityHostProcessor({
        ...deps,
        itx: itxForScope({
          auth: trustedInternalAuthContext(),
          ctx: this.ctx,
          path: this.#name.path,
          projectId: this.#name.projectId,
        }),
        // The enclosing scope, so a capability miss at this path falls through to
        // the surrounding scope (agent → its namespace → the project). Only the
        // immediate parent is wired; deeper ancestors are reached because that
        // parent applies the same fallback. Undefined at the root, which ends the
        // chain.
        parent: this.#parentCapabilityHost(),
        path: this.#name.path,
        scriptExecutionEntrypoint: this.#scriptExecutionEntrypoint(),
        validateCapabilityTypes: (types) =>
          checkCapabilityTypes({ types, typechecker: this.env.TYPECHECKER }),
        typecheckScript: (input) =>
          checkItxScriptForExecution({ ...input, typechecker: this.env.TYPECHECKER }),
      }),
  );

  #scriptExecutionEntrypoint(): ScriptExecutionEntrypoint {
    // Scripts execute in THIS scope, but the Dynamic Worker load happens in a
    // stateless loopback entrypoint instead of this Durable Object. Keep the
    // type shallow to avoid deep-instantiating the generated `ctx.exports`
    // WorkerEntrypoint type through the Durable Object's processor field.
    const exports = this.ctx.exports as unknown as ScriptExecutionLoopbackExports;
    return exports.ScriptExecutionEntrypoint({
      props: {
        scopePath: this.#name.path,
        projectId: this.#name.projectId,
      },
    });
  }

  #parentCapabilityHost(): ParentCapabilityHost | undefined {
    const parentPath = parentScopePath(this.#name.path);
    if (parentPath === null) return undefined;
    const parent = this.env.CAPABILITY_HOST.getByName(
      DurableObjectNameCodec.stringify({ path: parentPath, projectId: this.#name.projectId }),
    );
    // Forward only the two read methods the child scope chains through. Handing the
    // full DurableObjectStub over as a typed dependency makes TypeScript instantiate
    // the DO's self-referential stub type (TS2589); a thin forwarder keeps it shallow.
    return {
      invokeCapability: (input) => parent.invokeCapability(input),
      describeCapabilities: () => parent.describeCapabilities(),
    };
  }

  wakeStreamSubscriber(args: StreamSubscriberWakeRequest): Promise<StreamSubscriberWakeResponse> {
    return this.#processorHost.wakeStreamSubscriber(args);
  }

  /** The keepalive's revival alarm — see stream-processor-host.ts. */
  alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    return this.#processorHost.handleAlarm(alarmInfo);
  }

  /** Abort the current Durable Object incarnation; the next request boots it again. */
  kill(): void {
    this.ctx.abort("kill requested");
  }

  get processor() {
    return new StreamProcessorRpcTarget(this.#capabilityHostProcessor);
  }

  // Return types are pinned shallow so `DurableObjectStub<CapabilityHostDurableObject>`
  // doesn't deep-instantiate the processor's inferred signatures (TS2589).
  invokeCapability(input: { args?: unknown[]; path: string[] }): Promise<unknown> {
    return this.#capabilityHostProcessor.invokeCapability(input);
  }

  provideCapability(
    input: ProvideCapabilityInput,
  ): Promise<{ path: string[]; providedAtOffset: number }> {
    return this.#capabilityHostProcessor.provideCapability(input);
  }

  revokeCapability(input: { path: string[]; providedAtOffset?: number }): Promise<void> {
    return this.#capabilityHostProcessor.revokeCapability(input);
  }

  runScript(code: string): Promise<RunScriptResult> {
    return this.#capabilityHostProcessor.runScript(code);
  }

  describeCapabilities(): Promise<CapabilityDescription[]> {
    return this.#capabilityHostProcessor.describeCapabilities();
  }
}
