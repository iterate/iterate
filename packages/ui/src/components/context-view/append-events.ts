// The append composer's YAML, read as events: one event (a mapping) or a list of them, each checked
// only as far as `append` itself checks (a non-empty string `type`) plus the envelope's shape — an
// object `payload`/`metadata`, a string `idempotencyKey`, no other field. Anything else is the
// platform's to accept or refuse. Pure: the composer (append-composer.tsx) shows the error string.
import { parse, stringify } from "yaml";

/** What the composer hands `onAppend`: the part of an event a person may write. */
export type ContextViewAppendEvent = {
  type: string;
  payload?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
};

/** A prefilled draft: a type opaque to the platform (no `events.iterate.com/` prefix — see
 *  packages/iterate/README.md#event-types), so a stray append never reads as one of its facts. */
export const DEFAULT_APPEND_YAML = "type: manual/note-added\npayload:\n  text: Hello\n";

const FIELDS = new Set(["type", "payload", "metadata", "idempotencyKey"]);

/** The events the YAML names, or why it names none. An empty draft is an error too: nothing to send. */
export function parseAppendYaml(
  text: string,
): { events: ContextViewAppendEvent[] } | { error: string } {
  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch (error) {
    return { error: `Not YAML: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (parsed == null) return { error: "Nothing to append." };
  const list = Array.isArray(parsed) ? parsed : [parsed];
  if (list.length === 0) return { error: "Nothing to append." };
  const events: ContextViewAppendEvent[] = [];
  for (const [index, entry] of list.entries()) {
    const where = Array.isArray(parsed) ? `Event ${String(index + 1)}: ` : "";
    if (!isObject(entry)) return { error: `${where}an event is a mapping with a \`type\`.` };
    const unknown = Object.keys(entry).find((key) => !FIELDS.has(key));
    if (unknown) return { error: `${where}unknown field \`${unknown}\`.` };
    const { type, payload, metadata, idempotencyKey } = entry;
    if (typeof type !== "string" || type.trim() === "")
      return { error: `${where}\`type\` must be a non-empty string.` };
    if (payload !== undefined && !isObject(payload))
      return { error: `${where}\`payload\` must be a mapping.` };
    if (metadata !== undefined && !isObject(metadata))
      return { error: `${where}\`metadata\` must be a mapping.` };
    if (idempotencyKey !== undefined && typeof idempotencyKey !== "string")
      return { error: `${where}\`idempotencyKey\` must be a string.` };
    events.push({ type, payload, metadata, idempotencyKey });
  }
  return { events };
}

/** A draft for one type, as the examples load it. */
export function exampleYaml(type: string): string {
  return stringify({ type, payload: {} });
}

/** The types the context's processors consume, each once, sorted — the examples a person can load:
 *  what some processor here reacts to. Wildcards (`*`, `…/*`) name no one type and are left out. */
export function exampleTypes(processors: readonly { consumes?: readonly string[] }[]): string[] {
  const types = new Set<string>();
  for (const processor of processors)
    for (const type of processor.consumes || []) if (!type.includes("*")) types.add(type);
  return [...types].sort();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
