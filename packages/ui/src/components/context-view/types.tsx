// The context view's vocabulary: a committed event as the view reads it (structural — the itx
// envelope is a superset), the renderers an app plugs in per event type, and the rows the panels
// show. Pure types: this directory renders data the SDK's hooks (`iterate/react`) hand it.
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
    /** The platform wrote this fact on the principal's behalf (packages/iterate/src/principal.ts `Caller.platform`). */
    platform?: true;
  };
};

/** How the log reads: `pretty` — one sentence per event (the platform's own
 *  events come with theirs; an app adds its vocabulary; a type nobody names shows the type and a
 *  glance at the payload's fields), the platform's housekeeping folded into one quiet row, a fact
 *  repeated back-to-back shown once with its count; `pretty-raw` — every event, its sentence and
 *  its raw line; `raw` — the type and the payload's JSON, one line each, the log as data. */
export type ContextViewMode = "pretty" | "pretty-raw" | "raw";

/** A rich rendering of one event's body — what the row shows instead of the type and the payload
 *  preview. Return null to fall back to the default row. */
export type EventRenderer = (event: ContextViewEvent) => ReactNode | null;

/** Renderers by event type: an exact type, or a prefix ending in `*` — the most specific wins. */
export type EventRenderers = Record<string, EventRenderer>;

/** A rich body for one event in the inspector — the message as prose, the script as code, the
 *  model's answer — shown above the envelope and the raw JSON. Return null for the default. */
export type EventInspector = (event: ContextViewEvent) => ReactNode | null;

/** Inspectors by event type, matched like renderers. */
export type EventInspectors = Record<string, EventInspector>;

/** The entry of a by-type registry (renderers, inspectors) for a type: the exact type, else the
 *  longest prefix pattern (`events.iterate.com/agent/*`) that matches. */
export function rendererFor<T>(
  registry: Record<string, T> | undefined,
  type: string,
): T | undefined {
  if (!registry) return undefined;
  if (registry[type]) return registry[type];
  let best: { prefix: string; entry: T } | undefined;
  for (const [pattern, entry] of Object.entries(registry)) {
    if (!pattern.endsWith("*")) continue;
    const prefix = pattern.slice(0, -1);
    if (type.startsWith(prefix) && (!best || prefix.length > best.prefix.length))
      best = { prefix, entry };
  }
  return best?.entry;
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
