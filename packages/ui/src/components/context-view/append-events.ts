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

/** The examples a person can load, grouped by the processors that consume them (the old platform's
 *  examples panel, one group per processor): what some processor here reacts to. Processors that
 *  consume the same types share one group (a tab's live-state subscribers are many and alike), named
 *  by the first and how many more; a type shows once, in its first group. Wildcards (`*`, `…/*`)
 *  name no one type and are left out; a group with no type left is dropped. */
export function exampleGroups(
  processors: readonly { name: string; consumes?: readonly string[] }[],
): { label: string; types: string[] }[] {
  const byTypes = new Map<string, { names: string[]; types: string[] }>();
  for (const processor of [...processors].sort((a, b) => a.name.localeCompare(b.name))) {
    const types = [...new Set(processor.consumes || [])]
      .filter((type) => !type.includes("*"))
      .sort();
    const key = types.join("\n");
    const group = byTypes.get(key) || { names: [], types };
    group.names.push(processor.name);
    byTypes.set(key, group);
  }
  const shown = new Set<string>();
  const groups: { label: string; types: string[] }[] = [];
  for (const { names, types } of byTypes.values()) {
    const fresh = types.filter((type) => !shown.has(type));
    for (const type of fresh) shown.add(type);
    if (fresh.length === 0) continue;
    const label = names.length > 1 ? `${names[0]!} +${String(names.length - 1)}` : names[0]!;
    groups.push({ label, types: fresh });
  }
  return groups;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
