/**
 * CodemodeSession implementation sketch.
 *
 * This file is intentionally a design prototype, not production code. It is
 * here to make the next implementation slice concrete enough to critique.
 */

import { DurableObject, RpcTarget } from "cloudflare:workers";
import { createEventsClient, EventInput, StreamPath } from "@iterate-com/events-contract";
import { dispatchCallable } from "@iterate-com/shared/callable/runtime.ts";
import type { CallableContext } from "@iterate-com/shared/callable/types.ts";
import type { ToolProviderDescriptor } from "@iterate-com/shared/codemode/types";
import { withD1ObjectCatalog } from "@iterate-com/shared/durable-object-utils/mixins/with-d1-object-catalog";
import { withDurableObjectCore } from "@iterate-com/shared/durable-object-utils/mixins/with-durable-object-core";
import { withLifecycleHooks } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";
import { withKvInspector } from "@iterate-com/shared/durable-object-utils/mixins/with-kv-inspector";
import { withOuterbase } from "@iterate-com/shared/durable-object-utils/mixins/with-outerbase";

export type CodemodeSessionInitParams = {
  name: string;
  streamPath: StreamPath;
};

type Env = {
  DO_CATALOG: D1Database;
  EVENTS_BASE_URL: string;
  LOADER: WorkerLoader;
  // Main os2 worker should pass ctx.exports when using loopback callables.
  // The tiny worker can also export provider bridge classes itself later.
  exports?: Record<string, unknown>;
};

type ToolFunctionCall = {
  path: string[];
  payload: unknown;
  scriptExecutionRequestedOffset?: number;
};

type CodemodeSessionCapability = {
  callToolFunction(call: ToolFunctionCall): Promise<unknown>;
  append(input: EventInput): Promise<{ event: unknown }>;
  getStreamPath(): Promise<StreamPath>;
  executeScript(input: { code: string }): Promise<{ event: unknown }>;
};

const CodemodeSessionBase = withKvInspector({
  unsafe: "I_UNDERSTAND_THIS_EXPOSES_KV",
})(
  withOuterbase({
    unsafe: "I_UNDERSTAND_THIS_EXPOSES_SQL",
  })(
    withD1ObjectCatalog<CodemodeSessionInitParams, Pick<Env, "DO_CATALOG">>({
      className: "CodemodeSession",
      getDatabase(env) {
        return env.DO_CATALOG;
      },
      indexes: {
        streamPath(params) {
          return params.streamPath;
        },
      },
    })(withLifecycleHooks<CodemodeSessionInitParams>()(withDurableObjectCore(DurableObject))),
  ),
);

const TOOL_PROVIDER_REGISTRY_KEY = "codemode.tool-provider-registry.v1";

export class CodemodeSession extends CodemodeSessionBase<Env> {
  getStreamPath() {
    return this.assertInitialized().streamPath;
  }

  async append(input: EventInput) {
    const event = EventInput.parse(input);
    return await createEventsClient(this.env.EVENTS_BASE_URL).append({
      path: this.getStreamPath(),
      event,
    });
  }

  async registerToolProvider(descriptor: ToolProviderDescriptor) {
    const current = this.readRegistry();
    const pathKey = formatProviderPathKey(descriptor.path);
    current[pathKey] = descriptor;
    this.writeRegistry(current);

    return await this.append({
      type: "events.iterate.com/codemode/tool-provider-registered",
      payload: {
        path: descriptor.path,
        descriptor,
      },
      idempotencyKey: `tool-provider-registered:${pathKey}`,
    });
  }

  async describeToolProviders() {
    const registry = this.readRegistry();
    const descriptions: Array<{ path: string[]; typeDefinitions: string }> = [];

    for (const descriptor of Object.values(registry)) {
      if (!descriptor.describeToolFunctions) continue;
      const result = await dispatchCallable({
        callable: descriptor.describeToolFunctions,
        payload: {},
        ctx: this.callableContext(),
      });

      if (
        result != null &&
        typeof result === "object" &&
        "typeDefinitions" in result &&
        typeof result.typeDefinitions === "string"
      ) {
        descriptions.push({
          path: descriptor.path,
          typeDefinitions: result.typeDefinitions,
        });
      }
    }

    return descriptions;
  }

  async executeScript(input: { code: string }) {
    const requested = await this.append({
      type: "events.iterate.com/codemode/script-execution-requested",
      payload: {
        code: input.code,
      },
    });

    // Fire-and-append-result. The core API is start-only; callers that want to
    // wait can subscribe to this.getStreamPath() from requested.event.offset - 1.
    void this.runScript({
      code: input.code,
      scriptExecutionRequestedOffset: readEventOffset(requested.event),
    });

    return requested;
  }

  async callToolFunction(call: ToolFunctionCall) {
    const registry = this.readRegistry();
    const { descriptor, toolPath } = resolveProviderDescriptor(registry, call.path);
    const requested = await this.append({
      type: "events.iterate.com/codemode/tool-function-call-requested",
      payload: {
        path: call.path,
        payload: call.payload,
        scriptExecutionRequestedOffset: call.scriptExecutionRequestedOffset,
      },
    });

    try {
      const result = await dispatchCallable({
        callable: descriptor.executeToolFunction,
        payload: {
          path: toolPath,
          payload: call.payload,
          codemodeSessionCapability: this.getScopedRpcTarget(),
        },
        ctx: this.callableContext(),
      });

      await this.append({
        type: "events.iterate.com/codemode/tool-function-call-succeeded",
        payload: {
          toolFunctionCallRequestedOffset: readEventOffset(requested.event),
          path: call.path,
          result,
          scriptExecutionRequestedOffset: call.scriptExecutionRequestedOffset,
        },
      });

      return result;
    } catch (error) {
      await this.append({
        type: "events.iterate.com/codemode/tool-function-call-failed",
        payload: {
          toolFunctionCallRequestedOffset: readEventOffset(requested.event),
          path: call.path,
          error: error instanceof Error ? error.message : String(error),
          scriptExecutionRequestedOffset: call.scriptExecutionRequestedOffset,
        },
      });
      throw error;
    }
  }

  getScopedRpcTarget(): CodemodeSessionCapability {
    return new ScopedCodemodeSessionCapability(this);
  }

  private async runScript(input: { code: string; scriptExecutionRequestedOffset: number }) {
    // Prototype placeholder:
    // 1. create a dynamic worker
    // 2. pass this.getScopedRpcTarget()
    // 3. copied worker helper builds ctx from the capability
    // 4. append succeeded/failed with scriptExecutionRequestedOffset
    void input;
  }

  private callableContext(): CallableContext {
    return {
      env: this.env,
      exports: this.env.exports ?? {},
      fetch: globalThis.fetch,
      loader: this.env.LOADER,
    };
  }

  private readRegistry(): Record<string, ToolProviderDescriptor> {
    return (
      this.getDurableObjectKv().get<Record<string, ToolProviderDescriptor>>(
        TOOL_PROVIDER_REGISTRY_KEY,
      ) ?? {}
    );
  }

  private writeRegistry(value: Record<string, ToolProviderDescriptor>) {
    this.getDurableObjectKv().put(TOOL_PROVIDER_REGISTRY_KEY, value);
  }
}

class ScopedCodemodeSessionCapability extends RpcTarget implements CodemodeSessionCapability {
  #session: CodemodeSession;

  constructor(session: CodemodeSession) {
    super();
    this.#session = session;
  }

  async callToolFunction(call: ToolFunctionCall) {
    return await this.#session.callToolFunction(call);
  }

  async append(input: EventInput) {
    return await this.#session.append(input);
  }

  async getStreamPath() {
    return this.#session.getStreamPath();
  }

  async executeScript(input: { code: string }) {
    return await this.#session.executeScript(input);
  }
}

function resolveProviderDescriptor(
  registry: Record<string, ToolProviderDescriptor>,
  fullPath: string[],
) {
  const matches = Object.values(registry)
    .filter((descriptor) => isPrefix(descriptor.path, fullPath))
    .sort((left, right) => right.path.length - left.path.length);
  const descriptor = matches[0];
  if (!descriptor) throw new Error(`No Tool Provider registered for path ${fullPath.join(".")}`);

  return {
    descriptor,
    toolPath: fullPath.slice(descriptor.path.length),
  };
}

function isPrefix(prefix: string[], value: string[]) {
  return prefix.every((segment, index) => value[index] === segment);
}

function formatProviderPathKey(path: string[]) {
  return path.join("/");
}

function readEventOffset(event: unknown) {
  if (event != null && typeof event === "object" && "offset" in event) {
    const offset = event.offset;
    if (typeof offset === "number") return offset;
  }
  throw new Error("Expected appended event to include offset.");
}
