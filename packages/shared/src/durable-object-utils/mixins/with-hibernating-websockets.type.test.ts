import { DurableObject } from "cloudflare:workers";
import { describe, expectTypeOf, it } from "vitest";
import {
  UnknownDurableObjectViewError,
  withDurableObjectViews,
} from "./with-durable-object-views.ts";
import type { HibernatingWebSocketConnection } from "./with-hibernating-websockets.ts";
import { withHibernatingWebSockets } from "./with-hibernating-websockets.ts";
import { withLifecycleHooks } from "./with-lifecycle-hooks.ts";

type RoomInit = {
  name: string;
  ownerUserId: string;
};

type Env = {
  EXAMPLE: string;
};

const WebSocketRoomBase = withHibernatingWebSockets<RoomInit>()(
  withLifecycleHooks<RoomInit>()(DurableObject),
);

class WebSocketRoom extends WebSocketRoomBase<Env> {
  protected onHibernatingWebSocketConnect(
    connection: HibernatingWebSocketConnection<{ cursor: string }>,
  ) {
    connection.setHibernatingWebSocketAttachment({ cursor: this.initParams.ownerUserId });
  }

  protected onHibernatingWebSocketMessage(connection: HibernatingWebSocketConnection) {
    this.broadcastHibernatingWebSocketMessage("hello", { except: connection.id });
  }

  listConnectionsForTest() {
    return Array.from(this.getHibernatingWebSockets()).map((connection) => connection.id);
  }
}

type RoomView = {
  ownerUserId: string;
};

type RoomViews = {
  default: RoomView;
  room: RoomView;
};

const ViewRoomBase = withDurableObjectViews<RoomViews>()(WebSocketRoomBase);

class ViewRoom extends ViewRoomBase<Env> {
  protected getDurableObjectView(view = "default"): RoomView {
    switch (view) {
      case "default":
      case "room":
        return { ownerUserId: this.initParams.ownerUserId };

      default:
        throw new UnknownDurableObjectViewError(view);
    }
  }

  async broadcastRoomViewForTest() {
    await this.broadcastDurableObjectView("room");
  }
}

describe("withHibernatingWebSockets types", () => {
  it("preserves Cloudflare's generic Durable Object base shape", () => {
    expectTypeOf(WebSocketRoom).toMatchTypeOf<
      abstract new (ctx: DurableObjectState, env: Env) => DurableObject<Env>
    >();
  });

  it("exposes hibernating websocket helpers to subclasses only", () => {
    const room = {} as WebSocketRoom;

    expectTypeOf(room.listConnectionsForTest()).toEqualTypeOf<string[]>();

    // @ts-expect-error connection traversal is protected and should not be remotely callable.
    room.getHibernatingWebSockets();
  });

  it("requires lifecycle hooks below the websocket mixin", () => {
    // @ts-expect-error withHibernatingWebSockets requires withLifecycleHooks() below it.
    withHibernatingWebSockets<RoomInit>()(DurableObject);
  });
});

describe("withDurableObjectViews types", () => {
  it("requires subclasses to implement the view method", () => {
    // @ts-expect-error subclasses must define how synchronized views are computed.
    class MissingViewRoom extends ViewRoomBase<Env> {}

    expectTypeOf(MissingViewRoom).toMatchTypeOf<
      abstract new (ctx: DurableObjectState, env: Env) => DurableObject<Env>
    >();
  });

  it("keeps view names typed for broadcasts", async () => {
    const room = {} as ViewRoom;

    expectTypeOf(await room.broadcastRoomViewForTest()).toEqualTypeOf<void>();

    class InvalidViewRoom extends ViewRoomBase<Env> {
      protected getDurableObjectView(view = "default"): RoomView {
        switch (view) {
          case "default":
          case "room":
            return { ownerUserId: this.initParams.ownerUserId };

          default:
            throw new UnknownDurableObjectViewError(view);
        }
      }

      async broadcastMissingViewForTest() {
        // @ts-expect-error only declared view names can be broadcast.
        await this.broadcastDurableObjectView("missing");
      }
    }

    expectTypeOf(InvalidViewRoom).toMatchTypeOf<
      abstract new (ctx: DurableObjectState, env: Env) => DurableObject<Env>
    >();
  });
});
