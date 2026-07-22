import type { LiveUpdate } from "./protocol.ts";

/** Owned handle for one live-state subscription. */
export type LiveStateSubscriptionHandle = Disposable & {
  ping(): boolean | Promise<boolean>;
  unsubscribe(): void;
};

/** Read-only live value exposed across a Cap'n Web capability boundary. */
export interface LiveStateRpc<State = unknown> {
  get(): Promise<State>;
  subscribe(onUpdate: (update: LiveUpdate<State>) => unknown): Promise<LiveStateSubscriptionHandle>;
}
