/** Preview-only direct host for the existing VoiceAgentProcessor. */
import { VoiceAgentProcessor } from "@iterate-com/voice-agent/worker";
import {
  ProcessorFacet,
  type ProcessorFacetAlarmProxy,
  type ProcessorFacetHost,
  type ProcessorFacetIdentity,
} from "iterate/processors/cloudflare";
import { trustedInternalAuthContext } from "../../auth.ts";
import { workerVersion, type Env } from "../../env.ts";
import { STREAM_DURABLE_OBJECT_STUB, StreamRpcTarget } from "../../rpc-targets.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { projectEgressFetcher } from "../projects/utils.ts";
import type { StatefulDynamicWorkerRef } from "../workers/schemas.ts";
import type { HostedStreamMethod } from "./hosted-stream-routing.ts";

export const INLINE_VOICE_PROCESSOR_PREFIX =
  "/agents/voice/startup-colocated/handshake-overlap/overlap/inline/";
export const INLINE_VOICE_PROCESSOR_LOCAL_PREFIX = `${INLINE_VOICE_PROCESSOR_PREFIX}local/`;
export const INLINE_VOICE_PROCESSOR_PROJECT_ID = "prj_56cbca83186a40019f5792b2463c81fa";
export const INLINE_VOICE_PROCESSOR_SUBSCRIPTION = "voice-agent";
export const INLINE_VOICE_PROCESSOR_SOURCE_PIN = "ebb0a42dc2b1a44ae5cee36f87eee448a914b664";

export function isInlineVoiceProcessorTreatment(input: {
  deploymentEnv: string | undefined;
  path: string;
  projectId: string | null;
  subscriptionName: string;
}): boolean {
  return (
    input.deploymentEnv === "preview_17" &&
    input.projectId === INLINE_VOICE_PROCESSOR_PROJECT_ID &&
    input.path.startsWith(INLINE_VOICE_PROCESSOR_PREFIX) &&
    input.subscriptionName === INLINE_VOICE_PROCESSOR_SUBSCRIPTION
  );
}

/** The immutable userspace source remains installed; this admits one exact row. */
export function isInlineVoiceProcessorExperiment(input: {
  path: string;
  worker: StatefulDynamicWorkerRef;
}): boolean {
  const { worker } = input;
  const source = "createWorker" in worker.source ? worker.source.createWorker : undefined;
  const files = source?.files;
  return (
    worker.path === input.path &&
    worker.className === "VoiceAgentFacet" &&
    source?.entryPoint === "voice-agent.ts" &&
    files?.type === "repo" &&
    files.repoPath === "/repos/config" &&
    !!files.ref &&
    "commitOid" in files.ref &&
    files.ref.commitOid === INLINE_VOICE_PROCESSOR_SOURCE_PIN
  );
}

export type InlineVoiceProcessorHostOptions = {
  env: Env;
  identity: ProcessorFacetIdentity;
  invokeLocalStream?: (method: InlineVoiceLocalStreamMethod, args: unknown[]) => Promise<unknown>;
  parentAlarms: ProcessorFacetAlarmProxy;
  rawCtx: DurableObjectState;
  streamCtx: DurableObjectState;
};

type InlineVoiceLocalStreamMethod = Extract<
  HostedStreamMethod,
  "append" | "appendIfStreamId" | "getEvent" | "getEvents" | "getEventPage"
>;

/** A StreamRpcTarget whose own-stream calls execute in the hosted child turn. */
class InlineVoiceStreamRpcTarget extends StreamRpcTarget {
  readonly #invokeLocalStream: (
    method: InlineVoiceLocalStreamMethod,
    args: unknown[],
  ) => Promise<unknown>;

  constructor(input: {
    invokeLocalStream: (method: InlineVoiceLocalStreamMethod, args: unknown[]) => Promise<unknown>;
    props: ConstructorParameters<typeof StreamRpcTarget>[0];
  }) {
    super(input.props);
    this.#invokeLocalStream = input.invokeLocalStream;
  }

  override get [STREAM_DURABLE_OBJECT_STUB]() {
    // Safe: these are the only native-stub verbs StreamRpcTarget reaches for
    // processor reads and appends. The child supplies each through its hosted
    // boundary, while `at()` remains inherited and therefore remote.
    return {
      append: (...args: unknown[]) => this.#invokeLocalStream("append", args),
      appendIfStreamId: (...args: unknown[]) => this.#invokeLocalStream("appendIfStreamId", args),
      getEvent: (...args: unknown[]) => this.#invokeLocalStream("getEvent", args),
      getEvents: (...args: unknown[]) => this.#invokeLocalStream("getEvents", args),
      getEventPage: (...args: unknown[]) => this.#invokeLocalStream("getEventPage", args),
    } as unknown as StreamRpcTarget[typeof STREAM_DURABLE_OBJECT_STUB];
  }
}

/**
 * ProcessorFacet used locally in the hosted StreamDO child. DurableObject
 * receives its native context; the inherited registry then uses the child's
 * hosted storage/alarm view, exactly as StreamDurableObjectBase does.
 */
export class InlineVoiceProcessorHost extends ProcessorFacet<Env> {
  readonly #identity: ProcessorFacetIdentity;
  readonly #invokeLocalStream:
    | ((method: InlineVoiceLocalStreamMethod, args: unknown[]) => Promise<unknown>)
    | undefined;
  readonly #parentAlarms: ProcessorFacetAlarmProxy;

  constructor(options: InlineVoiceProcessorHostOptions) {
    super(options.rawCtx, options.env);
    if (!options.identity.projectId) {
      throw new Error("inline voice processor requires a project stream");
    }
    if (
      !isInlineVoiceProcessorTreatment({
        deploymentEnv: options.env.DEPLOYMENT_ENV,
        projectId: options.identity.projectId,
        path: options.identity.path,
        subscriptionName: INLINE_VOICE_PROCESSOR_SUBSCRIPTION,
      })
    ) {
      throw new Error("inline voice processor is outside its preview experiment scope");
    }
    const parentName = DurableObjectNameCodec.stringify(
      { path: options.identity.path, projectId: options.identity.projectId },
      { allowNullProjectId: true },
    );
    if (options.identity.parentName !== parentName) {
      throw new Error("inline voice processor parent identity does not match its child stream");
    }
    // This is the same child's native context with only its logical id and
    // alarm storage view replaced; the generic affects user state typing only.
    this.ctx = options.streamCtx as DurableObjectState<{}>;
    this.#identity = options.identity;
    this.#invokeLocalStream = options.invokeLocalStream;
    this.#parentAlarms = options.parentAlarms;
    console.info("inline voice processor host created", {
      path: options.identity.path,
      projectId: options.identity.projectId,
      localStream: !!options.invokeLocalStream,
      sourcePin: INLINE_VOICE_PROCESSOR_SOURCE_PIN,
      version: workerVersion(options.env),
    });
  }

  protected parentAlarms(identity: ProcessorFacetIdentity): ProcessorFacetAlarmProxy {
    this.#assertIdentity(identity);
    return this.#parentAlarms;
  }

  protected createHost(identity: ProcessorFacetIdentity): ProcessorFacetHost {
    this.#assertIdentity(identity);
    const { path, projectId } = identity;
    if (!projectId) throw new Error("inline voice processor requires a project stream");
    const streamProps = { auth: trustedInternalAuthContext(), path, projectId };
    const stream = this.#invokeLocalStream
      ? new InlineVoiceStreamRpcTarget({
          invokeLocalStream: this.#invokeLocalStream,
          props: streamProps,
        })
      : new StreamRpcTarget(streamProps);
    const nativeProjectEgressFetcher = projectEgressFetcher(this.ctx.exports, projectId, {
      kind: "scope",
      scopePath: path,
    });
    return {
      stream,
      version: workerVersion(this.env),
      registerProcessors: (registry) => {
        registry.register(
          new VoiceAgentProcessor({
            stream,
            path,
            projectId,
            nowAtFacetMs: () => Date.now(),
            buildCacheKey: workerVersion(this.env),
            sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
            dialProvider: async () => {
              const response = await nativeProjectEgressFetcher.fetch(
                "https://api.openai.com/v1/live/sessions",
                {
                  headers: {
                    Upgrade: "websocket",
                    Authorization: 'Bearer getSecret("/secrets/openai")',
                  },
                },
              );
              const socket = response.webSocket;
              if (!socket) return null;
              socket.binaryType = "arraybuffer";
              socket.accept();
              return socket;
            },
          }),
          { name: INLINE_VOICE_PROCESSOR_SUBSCRIPTION, recovery: true },
        );
      },
    };
  }

  #assertIdentity(identity: ProcessorFacetIdentity): void {
    if (
      identity.parentName !== this.#identity.parentName ||
      identity.projectId !== this.#identity.projectId ||
      identity.path !== this.#identity.path
    ) {
      throw new Error("inline voice processor identity changed");
    }
  }
}
