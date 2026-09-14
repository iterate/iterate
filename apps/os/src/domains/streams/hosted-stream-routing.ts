import { RpcTarget } from "cloudflare:workers";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import type { LiveStatePagerUpgrade } from "../live-state-pager.ts";
import type { StreamDurableObject } from "./stream-durable-object.ts";

/** Preview-only logical-stream family for the warm-host experiment. */
export const HOSTED_STREAM_PREFIX = "/agents/voice/startup-colocated/";
export const HOSTED_STREAM_HOST_PATH = "/agents/voice/startup-hosted-host";
/** Internal native-fetch routing marker. It never leaves the same Worker
 * binding and is removed before the real child StreamDO receives the request. */
export const HOSTED_STREAM_LOGICAL_NAME_HEADER = "x-iterate-hosted-stream-logical-name";

export function isHostedStreamPrototypePath(path: string): boolean {
  return path.startsWith(HOSTED_STREAM_PREFIX);
}

/** Existing public Stream DO verbs that the prototype routes through its host. */
const HOSTED_STREAM_METHODS = [
  "append",
  "appendCoreEvents",
  "appendCoreEventsIfStreamId",
  "appendCoreEvent",
  "appendIfStreamId",
  "describeSubscription",
  "fetch",
  "getEvent",
  "getEventPage",
  "getEvents",
  "getMaxOffset",
  "getMaxOffsets",
  "getProcessorRuntimeState",
  "kill",
  "listSubscriptions",
  "openConnection",
  "processorFacade",
  "proxyDeleteAlarm",
  "proxyGetAlarm",
  "proxySetAlarm",
  "receiveCopiedEvents",
  "removeCopySubscription",
  "reset",
  "runtimeState",
  "setCopySubscription",
  "waitForEvent",
  "waitUntilProcessed",
] as const satisfies readonly Extract<keyof StreamDurableObject, string>[];

export type HostedStreamMethod = (typeof HOSTED_STREAM_METHODS)[number];

type StreamMethodResult<Method extends HostedStreamMethod> = StreamDurableObject[Method] extends (
  ...args: infer _Args
) => infer Result
  ? Result
  : never;
type StreamMethodArgs<Method extends HostedStreamMethod> = StreamDurableObject[Method] extends (
  ...args: infer Args
) => unknown
  ? Args
  : never;

/** Durable Object RPC always returns a promise, including for synchronous
 * StreamDO methods such as append and getMaxOffset. */
type HostedStreamChildStub = {
  [Method in Exclude<HostedStreamMethod, "fetch">]: (
    ...args: StreamMethodArgs<Method>
  ) => Promise<Awaited<StreamMethodResult<Method>>>;
} & {
  alarm(alarmInfo?: Parameters<StreamDurableObject["alarm"]>[0]): Promise<void>;
  // The public Durable Object stub fetch surface differs from the class's
  // Request-taking fetch handler.
  fetch(input: string, init?: RequestInit): Promise<LiveStatePagerUpgrade>;
};

export function isHostedStreamMethod(method: string): method is HostedStreamMethod {
  return HOSTED_STREAM_METHODS.includes(method as HostedStreamMethod);
}

export type HostedStreamHostInvoker = {
  fetch(input: string, init?: RequestInit): Promise<LiveStatePagerUpgrade>;
  invokeHostedStream(input: {
    args: unknown[];
    logicalName: string;
    method: HostedStreamMethod;
  }): Promise<unknown>;
};

/** One resolver result for a hosted child; no child state lives in this target. */
class HostedStreamRpcTarget extends RpcTarget {
  readonly #host: HostedStreamHostInvoker;
  readonly #logicalName: string;

  constructor(input: { host: HostedStreamHostInvoker; logicalName: string }) {
    super();
    this.#host = input.host;
    this.#logicalName = input.logicalName;
  }

  invoke(method: HostedStreamMethod, args: unknown[]): Promise<unknown> {
    if (!isHostedStreamMethod(method)) {
      throw new Error(`hosted stream prototype does not expose ${String(method)}`);
    }
    if (method === "fetch") {
      throw new Error("hosted stream fetch uses the native fetch path");
    }
    return this.#host.invokeHostedStream({ args, logicalName: this.#logicalName, method });
  }

  fetch(input: string, init?: RequestInit): Promise<LiveStatePagerUpgrade> {
    const headers = new Headers(init?.headers);
    headers.set(HOSTED_STREAM_LOGICAL_NAME_HEADER, encodeURIComponent(this.#logicalName));
    return this.#host.fetch(input, { ...init, headers });
  }
}

/**
 * Central path router. Its caller supplies the native `getByName` authority,
 * so this module has no direct Durable Object binding access.
 */
export function resolveStreamStub(input: {
  deploymentEnv: string | undefined;
  getByName(name: string): unknown;
  logicalName: string;
}): HostedStreamChildStub {
  const logical = DurableObjectNameCodec.parse(input.logicalName, { allowNullProjectId: true });
  if (input.deploymentEnv !== "preview_17" || !isHostedStreamPrototypePath(logical.path)) {
    // The supplied binding is the normal StreamDO binding; this structural
    // view only narrows it to the public methods this router forwards.
    return input.getByName(input.logicalName) as HostedStreamChildStub;
  }
  if (!logical.projectId)
    throw new Error("hosted stream prototype requires a project-scoped stream");
  // The same binding names the host StreamDO here. Its public RPC surface is
  // limited to the two methods declared by HostedStreamHostInvoker.
  const host = input.getByName(
    DurableObjectNameCodec.stringify({
      path: HOSTED_STREAM_HOST_PATH,
      projectId: logical.projectId,
    }),
  ) as HostedStreamHostInvoker;
  const target = new HostedStreamRpcTarget({ host, logicalName: input.logicalName });
  // A Proxy cannot preserve the generated Durable Object stub type. Every
  // string method is checked by invoke() before it can reach the host.
  return new Proxy(target, {
    get(value, property) {
      if (property === "then" || property === "catch" || property === "finally") return undefined;
      if (property === Symbol.dispose) {
        const dispose = Reflect.get(value, property);
        return typeof dispose === "function" ? dispose.bind(value) : dispose;
      }
      if (property === "invoke") return value.invoke.bind(value);
      if (property === "fetch") return value.fetch.bind(value);
      if (typeof property !== "string") return Reflect.get(value, property);
      return (...args: unknown[]) => value.invoke(property as HostedStreamMethod, args);
    },
  }) as unknown as HostedStreamChildStub;
}
