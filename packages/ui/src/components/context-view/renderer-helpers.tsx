// Payload readers for an `EventRenderers` registry: an event's payload is untyped JSON, and every
// registry (the platform's core-renderers.tsx, the dash's facts, the agents app's log) reads the
// same few shapes out of it and marks ids up the same way.

export const str = (value: unknown, fallback = "") =>
  typeof value === "string" ? value : fallback;

export const list = (value: unknown) => (Array.isArray(value) ? value.map(String) : []);

/** A plain object (the payload's shape): the `toString` brand, so arrays and class instances are not. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  Object.prototype.toString.call(value) === "[object Object]";

/** A plain object, else an empty one. */
export const record = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});

/** A muted mono span for an id, a path or a name inside a sentence. */
export const mono = (text: string) => (
  <span className="font-mono text-xs text-muted-foreground">{text}</span>
);
