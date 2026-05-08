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
const DEFAULT_DURABLE_OBJECT_VIEW = "default";

export type DurableObjectViewMessage<View extends string = string, Value = unknown> = {
  kind: typeof DURABLE_OBJECT_VIEW_MESSAGE_KIND;
  view: View;
  revision: string;
  value: Value;
};

type DurableObjectViewMap = { default: unknown };
type DurableObjectViewName<Views extends DurableObjectViewMap> = Extract<keyof Views, string>;
type DurableObjectViewValue<Views extends DurableObjectViewMap> =
  Views[DurableObjectViewName<Views>];

export class UnknownDurableObjectViewError extends Error {
  constructor(view: string) {
    super(`Unknown Durable Object view: ${view}`);
  }
}

export abstract class DurableObjectViewsProtected<Views extends DurableObjectViewMap> {
  /**
   * Return the full replacement value that should be synchronized to clients
   * subscribed to `view`.
   *
   * The mixin deliberately asks the subclass for the value instead of accepting
   * configured callbacks. That keeps persistence and domain modeling in the
   * Durable Object class: a view can be derived from SQLite, KV, runtime memory,
   * a stream projection, or any ordinary method. The mixin only owns connection
   * handling and the stable wire envelope.
   */
  protected abstract getDurableObjectView(
    _view?: string,
  ): DurableObjectViewValue<Views> | Promise<DurableObjectViewValue<Views>>;

  protected sendDurableObjectView<View extends DurableObjectViewName<Views>>(
    _connection: HibernatingWebSocketConnection,
    _view: View,
  ): Promise<void> {
    throw new Error("DurableObjectViewsProtected is type-only and should never run.");
  }

  protected broadcastDurableObjectView<View extends DurableObjectViewName<Views>>(
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
 * If no `view` param is present, the connection subscribes to the `"default"`
 * view. Subclasses that expose additional named views should branch inside
 * `getDurableObjectView(view)` and throw for unsupported names. The mixin does
 * not keep a separate runtime registry, because the Durable Object method is
 * the single authority for what values can be synchronized.
 */
export function withDurableObjectViews<
  Views extends DurableObjectViewMap = DurableObjectViewMap,
>() {
  return function <TBase extends DurableObjectClass>(
    Base: TBase & Constructor<HibernatingWebSocketsProtected>,
  ): WithDurableObjectViewsResult<TBase, Views> {
    // See RuntimeDurableObjectConstructor docs for why this cast is needed to access protected ctx/env.
    const BaseWithWebSockets = Base as unknown as RuntimeDurableObjectConstructor &
      Constructor<HibernatingWebSocketsProtected>;

    abstract class DurableObjectViewsMixin extends BaseWithWebSockets {
      protected abstract getDurableObjectView(
        view?: string,
      ): DurableObjectViewValue<Views> | Promise<DurableObjectViewValue<Views>>;

      protected async onHibernatingWebSocketConnect(
        connection: HibernatingWebSocketConnection,
        context: HibernatingWebSocketConnectionContext,
      ): Promise<void> {
        await super.onHibernatingWebSocketConnect(connection, context);

        const requestedViews = resolveRequestedViews(context.url);
        for (const view of requestedViews) {
          await this.sendDurableObjectView(connection, view as DurableObjectViewName<Views>);
        }
      }

      protected async sendDurableObjectView<View extends DurableObjectViewName<Views>>(
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

      protected async broadcastDurableObjectView<View extends DurableObjectViewName<Views>>(
        view: View,
        options?: { tag?: string; except?: string | readonly string[] },
      ): Promise<void> {
        const message = this.createDurableObjectViewMessage(view);
        this.broadcastHibernatingWebSocketMessage(
          JSON.stringify(isPromiseLike(message) ? await message : message),
          options,
        );
      }

      private createDurableObjectViewMessage<View extends DurableObjectViewName<Views>>(
        view: View,
      ):
        | DurableObjectViewMessage<View, Views[View]>
        | Promise<DurableObjectViewMessage<View, Views[View]>> {
        const value = this.getDurableObjectView(view);
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

        // `getDurableObjectView()` is intentionally easier for subclasses to
        // implement: it returns the union of all declared view values instead
        // of forcing a generic method with casts in every Durable Object class.
        // The caller still passes one concrete `view`, so the message envelope
        // can safely narrow the returned value back to that view's declared type
        // at the mixin boundary.
        return isPromiseLike(value)
          ? value.then((resolvedValue) => createMessage(resolvedValue as Views[View]))
          : createMessage(value as Views[View]);
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

function resolveRequestedViews(url: URL): string[] {
  const requested = url.searchParams.getAll("view");
  if (requested.length === 0) {
    return [DEFAULT_DURABLE_OBJECT_VIEW];
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
