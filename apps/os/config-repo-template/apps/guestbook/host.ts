// Stream-processor host for the guestbook. createWorker gets platform virtual
// modules (iterate/processors, iterate/sdk, iterate/live-state, capnweb).
import { RpcTarget, newWorkersWebSocketRpcResponse } from "@iterate-com/capnweb";
import { LiveStateRpcTarget, type LiveStateRpc } from "iterate/live-state";
import {
  type StreamEventInput,
  type StreamSubscriberWakeRequest,
  type StreamSubscriberWakeResponse,
} from "iterate/processors";
import {
  createStreamProcessorRegistry,
  type StreamProcessorRegistry,
} from "iterate/processors/cloudflare";
import { IterateDurableObject, itxProjectStream } from "iterate/sdk";
import {
  guestbookCreationEvents,
  guestbookStreamPath,
  guestbookSubscriptionConfigVersion,
} from "./ref.ts";
import { GuestbookProcessor, type GuestbookState } from "./processor.ts";

const SUBSCRIPTION_VERSION_STORAGE_KEY = "guestbook:subscription-config-version";

/** Public Cap'n Web root: live reduced state + sign. */
export type GuestbookApi = {
  liveState: LiveStateRpc<GuestbookState>;
  sign(name: string, message: string): Promise<void>;
};

export class GuestbookApp extends IterateDurableObject {
  #host:
    | {
        registry: StreamProcessorRegistry<GuestbookState>;
        reads: { currentState: GuestbookState };
      }
    | undefined;
  #configurationInFlight: Promise<void> | undefined;

  #ensureHost(projectId: string): {
    registry: StreamProcessorRegistry<GuestbookState>;
    reads: { currentState: GuestbookState };
  } {
    if (this.#host === undefined) {
      this.ctx.storage.kv.put("guestbook:project-id", projectId);
      const stream = itxProjectStream(this.env, guestbookStreamPath);
      // getLiveState is called only after register assigns `reads` (registry
      // refreshes run after construction). The `!` is the same lazy-init race
      // the platform secret DO uses — typed as optional only for the first
      // line of construction, never observed null at call time.
      let reads: { currentState: GuestbookState } | undefined;
      const registry = createStreamProcessorRegistry(this.ctx, {
        path: guestbookStreamPath,
        projectId,
        stream,
        version: this.env.ITERATE_WORKER_VERSION,
        getLiveState: () => reads!.currentState,
      });
      const guestbook = registry.register(
        new GuestbookProcessor({ path: guestbookStreamPath, projectId, stream }),
        { recovery: true },
      );
      reads = registry.reads(guestbook);
      this.#host = { registry, reads };
    }
    return this.#host;
  }

  async #freshHost(): Promise<{
    registry: StreamProcessorRegistry<GuestbookState>;
    reads: { currentState: GuestbookState };
  }> {
    let projectId = this.ctx.storage.kv.get<string>("guestbook:project-id");
    if (projectId === undefined) {
      using project = await this.env.ITX.get();
      projectId = await project.projectId;
    }
    return this.#ensureHost(projectId);
  }

  async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    const { registry } = await this.#freshHost();
    await registry.handleAlarm(alarmInfo);
  }

  async #appendWithCurrentSubscription(...events: StreamEventInput[]): Promise<void> {
    using project = await this.env.ITX.get();
    await project.streams.get(guestbookStreamPath).append(...guestbookCreationEvents(), ...events);
    this.ctx.storage.kv.put(SUBSCRIPTION_VERSION_STORAGE_KEY, guestbookSubscriptionConfigVersion);
  }

  async #ensureCurrentSubscription(): Promise<void> {
    if (
      this.ctx.storage.kv.get<number>(SUBSCRIPTION_VERSION_STORAGE_KEY) ===
      guestbookSubscriptionConfigVersion
    ) {
      return;
    }
    if (this.#configurationInFlight === undefined) {
      this.#configurationInFlight = this.#appendWithCurrentSubscription();
    }
    const pending = this.#configurationInFlight;
    try {
      await pending;
    } finally {
      if (this.#configurationInFlight === pending) this.#configurationInFlight = undefined;
    }
  }

  get processor() {
    return {
      wakeStreamSubscriber: async (
        request: StreamSubscriberWakeRequest,
      ): Promise<StreamSubscriberWakeResponse> => {
        if (request.stream.projectId === null) {
          throw new Error("the guestbook subscribes on project streams only");
        }
        const { registry } = this.#ensureHost(request.stream.projectId);
        return await registry.wakeStreamSubscriber(request);
      },
    };
  }

  async sign(name: string, message: string): Promise<void> {
    const trimmedName = name.trim().slice(0, 80);
    const trimmedMessage = message.trim().slice(0, 500);
    if (trimmedName.length === 0 || trimmedMessage.length === 0) return;
    await this.#appendWithCurrentSubscription({
      type: "events.iterate.com/guestbook/entry-signed",
      payload: { message: trimmedMessage, name: trimmedName },
      idempotencyKey: `guestbook/entry:${crypto.randomUUID()}`,
    });
  }

  /** Cap'n Web door: public live state + sign. Creates /guestbook on first contact. */
  async fetch(request: Request): Promise<Response> {
    await this.#ensureCurrentSubscription();
    const { registry } = await this.#freshHost();
    return newWorkersWebSocketRpcResponse(request, new PublicGuestbookApi(this, registry));
  }
}

class PublicGuestbookApi extends RpcTarget implements GuestbookApi {
  // One LiveStateRpcTarget per session: Cap'n Web property gets that mint a
  // fresh target every access thrash client subscriptions keyed on identity.
  readonly #liveState: LiveStateRpcTarget<GuestbookState>;

  constructor(
    private readonly app: GuestbookApp,
    registry: StreamProcessorRegistry<GuestbookState>,
  ) {
    super();
    this.#liveState = new LiveStateRpcTarget<GuestbookState>(registry);
  }

  get liveState(): LiveStateRpc<GuestbookState> {
    return this.#liveState;
  }

  async sign(name: string, message: string): Promise<void> {
    await this.app.sign(name, message);
  }
}
