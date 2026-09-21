// The context view's vocabulary: a committed event as the view reads it (structural — the itx
// envelope is a superset), the renderers an app plugs in per event type, and the rows the panels
// show. Pure types: this directory renders data the SDK's hooks (`iterate/next/react`:
// useContextLog, useContextProcessors, useContextPresence, useLiveState) hand it.
import type { ReactNode } from "react";

export type ContextViewEvent = {
  offset: number;
  type: string;
  createdAt: string;
  payload?: unknown;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
  source?: {
    principal?: { actor: string; email?: string };
    grant?: string;
    processor?: { slug: string; version: string };
  };
};

/** A rich rendering of one event's body — what the row shows instead of the type and the payload
 *  preview. Return null to fall back to the default row. */
export type EventRenderer = (event: ContextViewEvent) => ReactNode | null;

/** Renderers by event type: an exact type, or a prefix ending in `*` — the most specific wins. */
export type EventRenderers = Record<string, EventRenderer>;

export function rendererFor(
  renderers: EventRenderers | undefined,
  type: string,
): EventRenderer | undefined {
  if (!renderers) return undefined;
  if (renderers[type]) return renderers[type];
  let best: { prefix: string; renderer: EventRenderer } | undefined;
  for (const [pattern, renderer] of Object.entries(renderers)) {
    if (!pattern.endsWith("*")) continue;
    const prefix = pattern.slice(0, -1);
    if (type.startsWith(prefix) && (!best || prefix.length > best.prefix.length))
      best = { prefix, renderer };
  }
  return best?.renderer;
}

/** One row of the context's processors table (`itx.processors.list()`). */
export type ContextViewProcessor = {
  name: string;
  target: string;
  consumes?: string[];
  configuredAtOffset: number;
  hostedFacet?: { name: string; className: string; cacheKey?: string; restarts: number };
};

/** Who acted on the context, newest first, from the log's stamps. */
export type ContextViewPresence = {
  actor: string;
  email?: string;
  grant?: string;
  lastSeenAt: string;
};
