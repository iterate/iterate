import { DurableObject } from "cloudflare:workers";
import { describe, expectTypeOf, it } from "vitest";
import { withDurableObjectCore } from "./with-durable-object-core.ts";
import { withDurableObjectViews } from "./with-durable-object-views.ts";
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
  withLifecycleHooks<RoomInit>()(withDurableObjectCore(DurableObject)),
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

type RoomViewHost = {
  getRoomView(): RoomView;
};

const ViewRoomBase = withDurableObjectViews<{ room: RoomView }, RoomViewHost>({
  views: {
    room(room) {
      return room.getRoomView();
    },
  },
})(WebSocketRoomBase);

class ViewRoom extends ViewRoomBase<Env> implements RoomViewHost {
  getRoomView(): RoomView {
    return { ownerUserId: this.initParams.ownerUserId };
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
    // @ts-expect-error withHibernatingWebSockets requires withLifecycleHooks() and withDurableObjectCore() below it.
    withHibernatingWebSockets<RoomInit>()(DurableObject);
  });
});

describe("withDurableObjectViews types", () => {
  it("keeps view names typed for broadcasts", async () => {
    const room = {} as ViewRoom;

    expectTypeOf(await room.broadcastRoomViewForTest()).toEqualTypeOf<void>();

    class InvalidViewRoom extends ViewRoomBase<Env> implements RoomViewHost {
      getRoomView(): RoomView {
        return { ownerUserId: this.initParams.ownerUserId };
      }

      async broadcastMissingViewForTest() {
        // @ts-expect-error only configured view names can be broadcast.
        await this.broadcastDurableObjectView("missing");
      }
    }

    expectTypeOf(InvalidViewRoom).toMatchTypeOf<
      abstract new (ctx: DurableObjectState, env: Env) => DurableObject<Env>
    >();
  });
});
