import {
  LiveStateRpcTarget,
  RpcTarget,
  newWorkersWebSocketRpcResponse,
  type LiveStateRpc,
} from "iterate/sdk/capnweb";
import type {
  StreamEventInput,
  StreamSubscriberWakeRequest,
  StreamSubscriberWakeResponse,
} from "iterate/processors";
import {
  createStreamProcessorRegistry,
  type StreamProcessorRegistry,
} from "iterate/processors/cloudflare";
import { IterateDurableObject, itxProjectStream } from "iterate/sdk";
import { GuestbookProcessor, type GuestbookState } from "./processor.ts";

const guestbookStreamPath = "/guestbook";

/** One createApp Durable Object owns the page, API, processor, and live value. */
export class GuestbookApp extends IterateDurableObject {
  #registry: StreamProcessorRegistry<GuestbookState> | undefined;

  #ensureRegistry(projectId: string): StreamProcessorRegistry<GuestbookState> {
    if (this.#registry === undefined) {
      const stream = itxProjectStream(this.env, guestbookStreamPath);
      const registry = createStreamProcessorRegistry<GuestbookState>(this.ctx, {
        path: guestbookStreamPath,
        projectId,
        stream,
        version: this.env.ITERATE_WORKER_VERSION,
      });
      registry.register(new GuestbookProcessor({ path: guestbookStreamPath, projectId, stream }));
      this.#registry = registry;
    }
    return this.#registry;
  }

  async #freshRegistry(): Promise<StreamProcessorRegistry<GuestbookState>> {
    if (this.#registry !== undefined) return this.#registry;
    using project = await this.env.ITX.get();
    return this.#ensureRegistry(await project.projectId);
  }

  async #append(...events: StreamEventInput[]): Promise<void> {
    using project = await this.env.ITX.get();
    await project.streams.get(guestbookStreamPath).append(...events);
  }

  async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    await (await this.#freshRegistry()).handleAlarm(alarmInfo);
  }

  get processor() {
    return {
      wakeStreamSubscriber: async (
        request: StreamSubscriberWakeRequest,
      ): Promise<StreamSubscriberWakeResponse> => {
        if (request.stream.projectId === null) {
          throw new Error("the guestbook subscribes on project streams only");
        }
        return await this.#ensureRegistry(request.stream.projectId).wakeStreamSubscriber(request);
      },
    };
  }

  async sign(name: string, message: string): Promise<void> {
    const trimmedName = name.trim().slice(0, 80);
    const trimmedMessage = message.trim().slice(0, 500);
    if (trimmedName.length === 0 || trimmedMessage.length === 0) {
      throw new TypeError("Name and message are required");
    }
    await this.#append({
      type: "events.iterate.com/guestbook/entry-signed",
      payload: { message: trimmedMessage, name: trimmedName },
      idempotencyKey: `guestbook/entry:${crypto.randomUUID()}`,
    });
    const registry = await this.#freshRegistry();
    await registry.catchUp("guestbook");
    registry.refreshLive();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api") {
      const registry = await this.#freshRegistry();
      await registry.catchUp("guestbook");
      await registry.loadAndRefreshLive();
      return newWorkersWebSocketRpcResponse(request, new GuestbookApi(this, registry));
    }
    if (request.method !== "GET" || url.pathname !== "/") {
      return new Response("not found", { status: 404 });
    }
    return new Response(
      `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Guestbook</title>
    <style>
      :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
      body { margin: 0; padding: 2rem; }
      main { margin: 0 auto; max-width: 38rem; }
      form { display: grid; gap: .75rem; }
      input, textarea, button { font: inherit; padding: .6rem; }
      article { border-block-start: 1px solid #8886; margin-block-start: 1.25rem; padding-block-start: 1rem; }
      time { opacity: .65; }
      [role="alert"] { color: #c33; }
    </style>
  </head>
  <body>
    <main id="root"><p>Loading…</p></main>
    <script type="module" src="/apps/guestbook/client.js"></script>
  </body>
</html>`,
      {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "x-content-type-options": "nosniff",
        },
      },
    );
  }
}

export class GuestbookApi extends RpcTarget {
  readonly #liveState: LiveStateRpcTarget<GuestbookState>;

  constructor(
    private readonly app: GuestbookApp,
    registry: StreamProcessorRegistry<GuestbookState>,
  ) {
    super();
    this.#liveState = new LiveStateRpcTarget(registry);
  }

  get liveState(): LiveStateRpc<GuestbookState> {
    return this.#liveState;
  }

  async sign(name: string, message: string): Promise<void> {
    await this.app.sign(name, message);
  }
}
