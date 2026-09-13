import { StreamProcessorFacet, type ProcessorHostDeps, type Project } from "iterate/sdk";
import {
  defineProcessorContract,
  StreamProcessor,
  type ProcessEventArgs,
  type ReduceArgs,
} from "iterate/processors";
import { z } from "zod";
import { voiceDeviceFacetRef } from "./ref.ts";
import {
  assertVoiceProviderSecret,
  contentHash,
  disposeRpcStub,
  setupVoiceAgent,
  VoiceAgentContract,
} from "./voice-agent.ts";
import type { SetupVoiceDeviceOptions } from "./setup-options.ts";

const Activation = z.string().min(1).max(64);
const Created = "events.iterate.com/voice-device/conversation-created";
const MAX_HELD_MIC_BYTES = 16_000 * 2 * 21;
const DeviceState = z.object({
  instructions: z.string().default(""),
  visemes: z.boolean().default(false),
  call: z
    .object({
      activation: Activation,
      childStreamPath: z.string(),
      conversationId: z.string().nullable().default(null),
    })
    .nullable()
    .default(null),
  recentEndedActivations: z.array(Activation).max(2).default([]),
});

export const VoiceDeviceContract = defineProcessorContract({
  slug: "voice-agent",
  version: "1.0.0",
  description: "Routes a fixed Kit device stream to a fresh voice conversation per activation.",
  stateSchema: DeviceState,
  events: {
    ...VoiceAgentContract.events,
    [Created]: {
      description: "A device activation's child conversation.",
      payloadSchema: z.strictObject({ activation: Activation, childStreamPath: z.string() }),
    },
  },
  consumes: [
    "events.iterate.com/voice-agent/created",
    "events.iterate.com/voice-agent/configured",
    "events.iterate.com/voice-agent/mic-frame",
    "events.iterate.com/voice-agent/keepalive",
    "events.iterate.com/voice-agent/conversation-ended",
    "events.iterate.com/voice-agent/call-started",
    Created,
  ],
  emits: [
    Created,
    "events.iterate.com/voice-agent/mic-frame",
    "events.iterate.com/voice-agent/keepalive",
    "events.iterate.com/voice-agent/conversation-ended",
  ],
});
type Contract = typeof VoiceDeviceContract;
type DeviceState = z.infer<typeof DeviceState>;
type Opening = {
  activation: string;
  childStreamPath: string;
  micFrames: string[];
  micBytes: number;
  ready: boolean;
  cancelled: boolean;
  endReason: string | null;
};

function rememberEnded(state: DeviceState, activation: string) {
  return state.recentEndedActivations.includes(activation)
    ? state.recentEndedActivations
    : [activation, ...state.recentEndedActivations].slice(0, 2);
}

export class VoiceDeviceProcessor extends StreamProcessor<
  Contract,
  { withProject<T>(fn: (project: Project) => Promise<T>): Promise<T> }
> {
  readonly contract = VoiceDeviceContract;
  #opening: Opening | null = null;
  #activeChildPath: string | null = null;

  reduce({ state, event }: ReduceArgs<Contract>) {
    if (event.type === "events.iterate.com/voice-agent/configured")
      return {
        ...state,
        instructions: event.payload.instructions || "",
        visemes: event.payload.visemes ?? false,
      };
    if (event.type === Created) {
      if (state.call || state.recentEndedActivations.includes(event.payload.activation))
        return state;
      return { ...state, call: { ...event.payload, conversationId: null } };
    }
    if (event.type === "events.iterate.com/voice-agent/call-started") {
      if (
        state.call?.activation === event.payload.activation &&
        event.source?.processor?.stream.path === state.call.childStreamPath
      )
        return { ...state, call: { ...state.call, conversationId: event.payload.conversationId } };
      return state;
    }
    if (event.type !== "events.iterate.com/voice-agent/conversation-ended") return state;
    if (state.call?.activation !== event.payload.activation)
      return { ...state, recentEndedActivations: rememberEnded(state, event.payload.activation) };
    return {
      ...state,
      call: null,
      recentEndedActivations: rememberEnded(state, event.payload.activation),
    };
  }

  processEvent(args: ProcessEventArgs<Contract>): undefined {
    const { event, state } = args;
    this.#activeChildPath = state.call?.childStreamPath || null;
    if (args.delivery.caughtUp && state.call && !this.#opening) {
      args.blockProcessorWhile(() =>
        this.#endBoth(
          args,
          state.call!.activation,
          state.call!.childStreamPath,
          "the device conversation router restarted before its audio could be delivered",
        ),
      );
      return;
    }
    if (!event || event.type === Created) return;
    if (event.type === "events.iterate.com/voice-agent/mic-frame") {
      if (!event.payload.pcm || state.recentEndedActivations.includes(event.payload.activation))
        return;
      if (state.call && state.call.activation !== event.payload.activation) return;
      if (!state.call) {
        if (this.#opening?.activation === event.payload.activation) {
          this.#queueMic(args, this.#opening, event.payload.pcm);
          return;
        }
        if (this.#opening) return;
        const opening: Opening = {
          activation: event.payload.activation,
          childStreamPath: `${this.path}/${new Date(event.createdAt).toISOString().toLowerCase().replace(/[:.]/g, "-")}-${event.offset}`,
          micFrames: [],
          micBytes: 0,
          ready: false,
          cancelled: false,
          endReason: null,
        };
        this.#opening = opening;
        this.#queueMic(args, opening, event.payload.pcm);
        args.blockProcessorWhile(async () => {
          try {
            await args.append({
              type: Created,
              idempotencyKey: this.idempotencyKey(`child:${event.offset}`),
              payload: { activation: opening.activation, childStreamPath: opening.childStreamPath },
            });
            this.#startChild(args, state, opening);
          } catch (error) {
            if (this.#opening === opening) this.#opening = null;
            throw error;
          }
        });
        return;
      }
      if (this.#opening?.activation === event.payload.activation)
        this.#queueMic(args, this.#opening, event.payload.pcm);
      return;
    }
    if (event.type === "events.iterate.com/voice-agent/keepalive") {
      const opening = this.#opening;
      if (opening?.ready && !opening.cancelled)
        args.blockProcessorWhile(() =>
          args.appendTo(opening.childStreamPath, {
            type: "events.iterate.com/voice-agent/keepalive",
            ephemeral: true,
            payload: {},
          }),
        );
      return;
    }
    if (event.type !== "events.iterate.com/voice-agent/conversation-ended") return;
    const opening = this.#opening;
    const call = args.previousState.call;
    if (
      call?.activation !== event.payload.activation &&
      opening?.activation !== event.payload.activation
    )
      return;
    if (call && event.source?.processor?.stream.path === call.childStreamPath) {
      if (opening?.activation === event.payload.activation) this.#opening = null;
      return;
    }
    if (opening?.activation === event.payload.activation) {
      opening.cancelled = true;
      opening.micFrames = [];
      opening.micBytes = 0;
      opening.endReason = event.payload.reason;
      this.#opening = null;
      if (opening.ready)
        args.blockProcessorWhile(() => this.#endChild(args, opening, event.payload.reason));
      return;
    }
    if (!call) return;
    args.blockProcessorWhile(() =>
      args.appendTo(call.childStreamPath, {
        type: "events.iterate.com/voice-agent/conversation-ended",
        payload: { activation: event.payload.activation, reason: event.payload.reason },
      }),
    );
  }

  #startChild(args: ProcessEventArgs<Contract>, state: DeviceState, opening: Opening) {
    args.runInBackground(async () => {
      try {
        await this.deps.withProject((project) =>
          setupVoiceAgent(project, {
            streamPath: opening.childStreamPath,
            instructions: state.instructions,
            visemes: state.visemes,
            transportStreamPath: this.path,
            activation: opening.activation,
          }),
        );
        if (opening.cancelled) {
          await this.#endChild(
            args,
            opening,
            opening.endReason || "the device ended the call while its conversation was opening",
          );
          return;
        }
        while (opening.micFrames.length) {
          const frames = opening.micFrames.splice(0);
          opening.micBytes = 0;
          await args.appendTo(
            opening.childStreamPath,
            // Keep literal event discriminants: Array.map would otherwise widen
            // these known protocol values beyond the processor's event union.
            ...frames.map((pcm) => ({
              type: "events.iterate.com/voice-agent/mic-frame" as const,
              ephemeral: true as const,
              payload: { activation: opening.activation, pcm },
            })),
          );
          if (opening.cancelled) {
            await this.#endChild(
              args,
              opening,
              opening.endReason || "the device ended the call while its audio was being delivered",
            );
            return;
          }
        }
        opening.ready = true;
      } catch (error) {
        if (!opening.cancelled) {
          opening.cancelled = true;
          await this.#endBoth(
            args,
            opening.activation,
            opening.childStreamPath,
            `the fresh voice conversation could not be prepared: ${String(error).slice(0, 240)}`,
          );
        }
      } finally {
        if (this.#opening === opening && opening.cancelled) this.#opening = null;
      }
    });
  }
  #queueMic(args: ProcessEventArgs<Contract>, opening: Opening, pcm: string) {
    if (opening.cancelled) return;
    if (opening.ready) {
      args.blockProcessorWhile(() =>
        args.appendTo(opening.childStreamPath, {
          type: "events.iterate.com/voice-agent/mic-frame",
          ephemeral: true,
          payload: { activation: opening.activation, pcm },
        }),
      );
      return;
    }
    // Count decoded PCM bytes without allocating another audio buffer.
    const length =
      Math.floor(pcm.length / 4) * 3 - (pcm.endsWith("==") ? 2 : pcm.endsWith("=") ? 1 : 0);
    if (opening.micBytes + length <= MAX_HELD_MIC_BYTES) {
      opening.micFrames.push(pcm);
      opening.micBytes += length;
      return;
    }
    opening.cancelled = true;
    opening.micFrames = [];
    opening.micBytes = 0;
    opening.endReason =
      "the fresh voice conversation was not ready before 21000ms of microphone audio accumulated";
    args.blockProcessorWhile(() =>
      this.#endBoth(
        args,
        opening.activation,
        opening.childStreamPath,
        "the fresh voice conversation was not ready before 21000ms of microphone audio accumulated",
      ),
    );
  }
  #endChild(args: ProcessEventArgs<Contract>, opening: Opening, reason: string) {
    return args.appendTo(opening.childStreamPath, {
      type: "events.iterate.com/voice-agent/conversation-ended",
      payload: { activation: opening.activation, reason },
    });
  }
  async #endBoth(
    args: ProcessEventArgs<Contract>,
    activation: string,
    child: string,
    reason: string,
  ) {
    await Promise.all([
      args.append({
        type: "events.iterate.com/voice-agent/conversation-ended",
        idempotencyKey: this.idempotencyKey(`router-ended:${activation}`),
        payload: { activation, reason },
      }),
      args.appendTo(child, {
        type: "events.iterate.com/voice-agent/conversation-ended",
        payload: { activation, reason },
      }),
    ]);
  }
  override async getRuntimeState() {
    const child = this.#activeChildPath;
    if (!child) return { runtime: { face: null } };
    return this.deps.withProject(async (project) => {
      const stream = project.streams.get(child);
      try {
        const runtime = await stream.getProcessorRuntimeState({ name: "voice-agent" });
        try {
          return { runtime: { face: runtime?.runtime?.face || null } };
        } finally {
          disposeRpcStub(runtime, "device face runtime");
        }
      } finally {
        disposeRpcStub(stream, "device face stream");
      }
    });
  }
}

export async function setupVoiceDevice(
  project: Project,
  options: SetupVoiceDeviceOptions,
): Promise<{ streamPath: string; warmMs: number }> {
  if (!options.streamPath.startsWith("/")) {
    throw new Error(
      `voice-device streamPath must be absolute; received ${JSON.stringify(options.streamPath)}`,
    );
  }
  // Validate through the ordinary Agent API without creating a parent Agent.
  disposeRpcStub(await project.agents.get(options.streamPath), "device parent agent path");
  const stream = project.streams.get(options.streamPath);
  try {
    const payload = {
      name: VoiceDeviceContract.slug,
      description: "Route this Kit device stream to a fresh voice conversation per activation.",
      filter: { eventTypes: [...VoiceDeviceContract.consumes] },
      // Preserve the SDK receiver union's literal discriminants across this variable.
      receiver: {
        action: "facet-processor" as const,
        source: { kind: "userspace" as const, worker: voiceDeviceFacetRef(options.streamPath) },
      },
    };
    await assertVoiceProviderSecret(project);
    const existing = await stream.getProcessorRuntimeState({ name: VoiceDeviceContract.slug });
    try {
      const previous = DeviceState.safeParse(existing?.snapshot.state);
      const existingVoice = VoiceAgentContract.stateSchema.safeParse(existing?.snapshot.state);
      if (
        (previous.success && previous.data.call) ||
        (existingVoice.success && existingVoice.data.call)
      ) {
        throw new Error(
          "This device stream has an active call. End it before changing its voice setup.",
        );
      }
    } finally {
      disposeRpcStub(existing, "device existing runtime");
    }
    const committed = await stream.append(
      {
        type: "events.iterate.com/stream/subscription-configured",
        idempotencyKey: `voice-device/subscription:${options.streamPath}:${contentHash(payload)}`,
        payload,
      },
      {
        type: "events.iterate.com/voice-agent/created",
        idempotencyKey: `voice-device/created:${options.streamPath}`,
        payload: {},
      },
      {
        type: "events.iterate.com/voice-agent/configured",
        idempotencyKey: `voice-device/configured:${options.streamPath}:${crypto.randomUUID()}`,
        payload: { instructions: options.instructions, visemes: options.visemes },
      },
    );
    const offset = Math.max(...committed.map((event) => event.offset));
    disposeRpcStub(committed, "device setup append result");
    const startedAt = Date.now();
    const subscription = stream.subscriptions.get(VoiceDeviceContract.slug);
    try {
      await subscription.waitUntilProcessed({ offset, timeoutMs: 90_000 });
    } finally {
      disposeRpcStub(subscription, "device setup subscription");
    }
    return { streamPath: options.streamPath, warmMs: Date.now() - startedAt };
  } finally {
    disposeRpcStub(stream, "device setup stream");
  }
}

export class VoiceDeviceFacet extends StreamProcessorFacet {
  protected readonly recovery = true;
  protected createProcessor(deps: ProcessorHostDeps) {
    return new VoiceDeviceProcessor({
      ...deps,
      withProject: async <T>(fn: (project: Project) => Promise<T>) => {
        // ITX is injected with this facet's project scope. Its dynamic RPC
        // binding cannot expose the Project type, so assert that SDK contract here.
        const project = (await this.env.ITX.get()) as Project;
        try {
          return await fn(project);
        } finally {
          disposeRpcStub(project, "device project");
        }
      },
    });
  }
}
