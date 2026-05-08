import type { CallableContext } from "@iterate-com/shared/callable/types.ts";
import type { Event, EventInput } from "./types.ts";

/**
 * In-process processor shape used by `StreamDurableObject`.
 *
 * This is not the public stream processor contract model. Built-in processors
 * are privileged because `beforeAppend` runs before an event is committed and
 * can reject the write synchronously.
 */
export type BuiltinProcessor<State extends object> = {
  slug: string;
  initialState: State;
  beforeAppend?(args: { event: EventInput; state: State }): void;
  reduce?(args: { event: Event; state: State }): State;
  afterAppend?(args: {
    append: (event: EventInput) => Event | Promise<Event>;
    callableContext?: CallableContext;
    event: Event;
    state: State;
  }): Promise<void>;
};
