import { DurableObject } from "cloudflare:workers";
import type { Env } from "../../env.ts";
import type { CapabilityDescription } from "../itx/describe.ts";
import { trustedInternalAuthContext } from "../../auth.ts";
import { DurableObjectNameCodec, parentScopePath } from "../durable-object-names.ts";
import { DynamicWorkerRunner } from "../workers/worker-runner.ts";
import {
  createStreamProcessorHost,
  type StreamSubscriberWakeRequest,
} from "../streams/stream-processor-host.ts";
import { StreamProcessorRpcTarget } from "../../rpc-targets.ts";
import { itxForScope, StreamRpcTarget } from "../../rpc-targets.ts";
import {
  CapabilityHostProcessor,
  type ParentCapabilityHost,
  type RunScriptResult,
} from "./capability-host-processor-implementation.ts";
import type { ProvideCapabilityInput } from "./types.ts";

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
        // Scripts execute in THIS scope — the runner is minted once for it.
        dynamicWorkers: new DynamicWorkerRunner({
          exports: this.ctx.exports,
          projectId: this.#name.projectId,
          scopePath: this.#name.path,
          waitUntil: (promise) => this.ctx.waitUntil(promise),
        }),
      }),
  );

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

  wakeStreamSubscriber(args: StreamSubscriberWakeRequest): Promise<void> {
    return this.#processorHost.wakeStreamSubscriber(args);
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
