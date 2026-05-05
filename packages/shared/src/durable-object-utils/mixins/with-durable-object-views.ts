/// <reference types="@cloudflare/workers-types" />

import type {
  Constructor,
  DurableObjectClass,
  MembersOf,
  ReqEnvOf,
  RuntimeDurableObjectConstructor,
  StaticSide,
} from "./mixin-types.ts";
import type {
  HibernatingWebSocketConnection,
  HibernatingWebSocketConnectionContext,
  HibernatingWebSocketsProtected,
} from "./with-hibernating-websockets.ts";

const DURABLE_OBJECT_VIEW_MESSAGE_KIND = "durable-object-view";

export type DurableObjectViewMessage<View extends string = string, Value = unknown> = {
  kind: typeof DURABLE_OBJECT_VIEW_MESSAGE_KIND;
  view: View;
  revision: string;
  value: Value;
};

type DurableObjectViewMap = Record<string, unknown>;

type DurableObjectViewFactories<Views extends DurableObjectViewMap, Host> = {
  [View in Extract<keyof Views, string>]: (host: Host) => Views[View] | Promise<Views[View]>;
};

export abstract class DurableObjectViewsProtected<Views extends DurableObjectViewMap> {
  protected sendDurableObjectView<View extends Extract<keyof Views, string>>(
    _connection: HibernatingWebSocketConnection,
    _view: View,
  ): Promise<void> {
    throw new Error("DurableObjectViewsProtected is type-only and should never run.");
  }

  protected broadcastDurableObjectView<View extends Extract<keyof Views, string>>(
    _view: View,
    _options?: { tag?: string; except?: string | readonly string[] },
  ): Promise<void> {
    throw new Error("DurableObjectViewsProtected is type-only and should never run.");
  }
}

type WithDurableObjectViewsResult<
  TBase extends DurableObjectClass,
  Views extends DurableObjectViewMap,
> = StaticSide<TBase> &
  DurableObjectClass<
    ReqEnvOf<TBase>,
    MembersOf<TBase> & HibernatingWebSocketsProtected & DurableObjectViewsProtected<Views>
  > &
  Constructor<DurableObjectViewsProtected<Views>>;

/**
 * Synchronizes named Durable Object views to connected WebSocket clients.
 *
 * A "view" is the complete server-computed value a React component should put
 * in its cache and render. It is deliberately not called "state": the value may
 * be derived from SQLite tables, KV, runtime memory, stream-processor reduced
 * state, or another method on the Durable Object. This mixin only standardizes
 * the WebSocket message envelope and when initial/broadcast values are sent.
 *
 * The wire message is a full replacement snapshot:
 *
 *   { kind: "durable-object-view", view: "room", revision: "...", value: ... }
 *
 * The word "snapshot" stays in comments/protocol reasoning, not in the app API.
 * Later delta/patch messages can live beside this envelope without changing
 * the lower `withHibernatingWebSockets()` connection layer.
 *
 * Clients request views with repeated query params on the fixed WebSocket route:
 *
 *   /__websocket?view=room&view=presence
 *
 * If no `view` param is present and exactly one view is configured, that single
 * view is sent as a convenience. If multiple views exist, callers must request
 * them explicitly so a connection does not accidentally receive expensive or
 * sensitive views it did not ask for.
 *
 * Factories receive the Durable Object instance as an explicit `host` argument
 * instead of relying on JavaScript `this`. That keeps dependencies visible at
 * the call site and avoids the weak `this: any` pattern that tends to leak out
 * of callback-based APIs.
 */
export function withDurableObjectViews<
  Views extends DurableObjectViewMap,
  Host = unknown,
>(options: { views: DurableObjectViewFactories<Views, Host> }) {
  const viewNames = Object.keys(options.views);

  return function <TBase extends DurableObjectClass>(
    Base: TBase & Constructor<HibernatingWebSocketsProtected>,
  ): WithDurableObjectViewsResult<TBase, Views> {
    const BaseWithWebSockets = Base as unknown as RuntimeDurableObjectConstructor &
      Constructor<HibernatingWebSocketsProtected>;

    abstract class DurableObjectViewsMixin extends BaseWithWebSockets {
      protected async onHibernatingWebSocketConnect(
        connection: HibernatingWebSocketConnection,
        context: HibernatingWebSocketConnectionContext,
      ): Promise<void> {
        await super.onHibernatingWebSocketConnect(connection, context);

        const requestedViews = resolveRequestedViews(context.url, viewNames);
        for (const view of requestedViews) {
          await this.sendDurableObjectView(connection, view as Extract<keyof Views, string>);
        }
      }

      protected async sendDurableObjectView<View extends Extract<keyof Views, string>>(
        connection: HibernatingWebSocketConnection,
        view: View,
      ): Promise<void> {
        const message = this.createDurableObjectViewMessage(view);
        if (isPromiseLike(message)) {
          (this.getHibernatingWebSocket(connection.id) ?? connection).send(
            JSON.stringify(await message),
          );
          return;
        }

        (this.getHibernatingWebSocket(connection.id) ?? connection).send(JSON.stringify(message));
      }

      protected async broadcastDurableObjectView<View extends Extract<keyof Views, string>>(
        view: View,
        options?: { tag?: string; except?: string | readonly string[] },
      ): Promise<void> {
        const message = this.createDurableObjectViewMessage(view);
        this.broadcastHibernatingWebSocketMessage(
          JSON.stringify(isPromiseLike(message) ? await message : message),
          options,
        );
      }

      private createDurableObjectViewMessage<View extends Extract<keyof Views, string>>(
        view: View,
      ):
        | DurableObjectViewMessage<View, Views[View]>
        | Promise<DurableObjectViewMessage<View, Views[View]>> {
        const createView = options.views[view];
        if (createView === undefined) {
          throw new Error(`Unknown Durable Object view: ${view}`);
        }

        const value = createView(this as unknown as Host);
        const createMessage = (
          resolvedValue: Views[View],
        ): DurableObjectViewMessage<View, Views[View]> => {
          return {
            kind: DURABLE_OBJECT_VIEW_MESSAGE_KIND,
            view,
            // This revision is intentionally opaque. It lets React/client code
            // distinguish messages without implying durable ordering. If a view
            // needs ordered revisions, compute that inside the view value from
            // the app's own table/event offset.
            revision: crypto.randomUUID(),
            value: resolvedValue,
          };
        };

        return isPromiseLike(value) ? value.then(createMessage) : createMessage(value);
      }
    }

    return DurableObjectViewsMixin as unknown as WithDurableObjectViewsResult<TBase, Views>;
  };
}

export function isDurableObjectViewMessage(
  value: unknown,
): value is DurableObjectViewMessage<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  if (!("kind" in value) || value.kind !== DURABLE_OBJECT_VIEW_MESSAGE_KIND) return false;
  if (!("view" in value) || typeof value.view !== "string") return false;
  if (!("revision" in value) || typeof value.revision !== "string") return false;
  return "value" in value;
}

function resolveRequestedViews(url: URL, viewNames: string[]): string[] {
  const requested = url.searchParams.getAll("view");
  if (requested.length === 0) {
    return viewNames.length === 1 ? viewNames : [];
  }

  const knownViews = new Set(viewNames);
  const unknownViews = requested.filter((view) => !knownViews.has(view));
  if (unknownViews.length > 0) {
    throw new Error(`Unknown Durable Object view requested: ${unknownViews.join(", ")}`);
  }

  return Array.from(new Set(requested));
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}
