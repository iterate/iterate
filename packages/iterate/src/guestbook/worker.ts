/// <reference path="./virtual-client.d.ts" />
import guestbookClientSource from "iterate:guestbook-client-source";
import {
  LiveStateRpcTarget,
  RpcTarget,
  newWorkersWebSocketRpcResponse,
  type LiveStateRpc,
} from "../sdk/capnweb/index.ts";
import type { StreamProcessorRegistry } from "../processors/cloudflare.ts";
import { IterateDurableObject, createProcessorHost, type StreamEvent } from "../sdk.ts";
import { guestbookCreationEvents, guestbookStreamPath } from "./app-ref.ts";
import { GuestbookProcessor, type GuestbookState } from "./processor.ts";

/** One packaged Durable Object owns the page, API, processor, and live value. */
export class GuestbookApp extends IterateDurableObject {
  #host = createProcessorHost<GuestbookState>({
    ctx: this.ctx,
    env: this.env,
    path: guestbookStreamPath,
    createProcessor: (deps) => new GuestbookProcessor(deps),
  });

  async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    await this.#host.handleAlarm(alarmInfo);
  }

  /** Lazily initialize the stream and retire the former config-owned WAKE
   * subscription. The idempotency-keyed facts may be offered by every caller. */
  async #ensureInitialized(): Promise<StreamProcessorRegistry<GuestbookState>> {
    const registry = await this.#host.registry();
    await registry.catchUp("guestbook");
    using project = await this.env.ITX.get();
    await project.streams.get(guestbookStreamPath).append(...guestbookCreationEvents());
    await registry.catchUp("guestbook");
    return registry;
  }

  /** Project-worker event delivery calls this after a durable Guestbook event
   * commits. Catch-up owns validation, ordering, checkpointing, and dedupe. */
  async syncEvent(event: StreamEvent): Promise<void> {
    if (event.path !== guestbookStreamPath) return;
    const registry = await this.#ensureInitialized();
    await registry.catchUp("guestbook");
    registry.refreshLive();
  }

  /** Internal worker RPC surface used to verify source upgrades and delivery. */
  async getState(): Promise<GuestbookState> {
    await this.#ensureInitialized();
    return (await this.#host.snapshot()).state;
  }

  async sign(name: string, message: string): Promise<void> {
    const trimmedName = name.trim().slice(0, 80);
    const trimmedMessage = message.trim().slice(0, 500);
    if (trimmedName.length === 0 || trimmedMessage.length === 0) {
      throw new TypeError("Name and message are required");
    }
    const registry = await this.#ensureInitialized();
    using project = await this.env.ITX.get();
    await project.streams.get(guestbookStreamPath).append({
      type: "events.iterate.com/guestbook/entry-signed",
      payload: { message: trimmedMessage, name: trimmedName },
      idempotencyKey: `guestbook/entry:${crypto.randomUUID()}`,
    });
    await registry.catchUp("guestbook");
    registry.refreshLive();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api") {
      const registry = await this.#ensureInitialized();
      await registry.loadAndRefreshLive();
      return newWorkersWebSocketRpcResponse(request, new GuestbookApi(this, registry));
    }
    if (request.method === "GET" && url.pathname === "/apps/guestbook/client.js") {
      return new Response(guestbookClientSource, {
        headers: {
          "content-type": "application/javascript; charset=utf-8",
          "x-content-type-options": "nosniff",
        },
      });
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
  readonly #app: GuestbookApp;
  readonly #liveState: LiveStateRpcTarget<GuestbookState>;

  constructor(app: GuestbookApp, registry: StreamProcessorRegistry<GuestbookState>) {
    super();
    this.#app = app;
    this.#liveState = new LiveStateRpcTarget(registry);
  }

  get liveState(): LiveStateRpc<GuestbookState> {
    return this.#liveState;
  }

  async sign(name: string, message: string): Promise<void> {
    await this.#app.sign(name, message);
  }
}
