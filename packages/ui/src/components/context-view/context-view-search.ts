// The context view's state as a URL's search — every choice a person makes in the view that they
// would share or come back to: the mode, the filter (query, types, actor, offset range), the
// inspected event, the processors sheet, the filter row. zod only, router-agnostic: an app's route hands the parsed
// search in as `state` and applies `onStateChange` patches with its router (`validateSearch:
// ContextViewState`, `navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true })`).
// Every key `.catch(undefined)`: a hand-edited `?event=abc` is an absent key, never an error page.
import { z } from "zod";
import type { ContextViewFilter } from "./filters.tsx";

export const ContextViewState = z.object({
  /** How the log reads; omitted = the app's default (Pretty). */
  mode: z.enum(["pretty", "pretty-raw", "raw"]).optional().catch(undefined),
  /** The text query over the type and the payload. */
  q: z.string().optional().catch(undefined),
  /** The event types left ticked; omitted = all. */
  types: z.array(z.string()).optional().catch(undefined),
  /** One actor's events only. */
  actor: z.string().optional().catch(undefined),
  /** The lowest offset shown, inclusive. */
  from: z.number().int().nonnegative().optional().catch(undefined),
  /** The highest offset shown, inclusive. */
  to: z.number().int().nonnegative().optional().catch(undefined),
  /** The inspected event's offset — the inspector is open. */
  event: z.number().int().nonnegative().optional().catch(undefined),
  /** The processors sheet is open. */
  processors: z.literal(true).optional().catch(undefined),
  /** The filter row is open. */
  filter: z.literal(true).optional().catch(undefined),
});

/** The view's state — what `ContextView` reads and patches; a URL's search in every app. */
export type ContextViewState = z.infer<typeof ContextViewState>;

/** The filter the rows are narrowed by, from the state's filter keys. */
export function contextViewFilterOf(state: ContextViewState): ContextViewFilter {
  return {
    query: state.q || "",
    types: new Set(state.types || []),
    actor: state.actor,
    from: state.from,
    to: state.to,
  };
}

/** The patch that drops every filter key (the filter row's "clear"). */
export const FILTER_CLEARED = {
  q: undefined,
  types: undefined,
  actor: undefined,
  from: undefined,
  to: undefined,
} satisfies Partial<ContextViewState>;

/** The keys that claim the view's right edge — an opener clears the others so one sheet shows. */
export const RIGHT_EDGE_CLOSED = {
  event: undefined,
  processors: undefined,
} satisfies Partial<ContextViewState>;
