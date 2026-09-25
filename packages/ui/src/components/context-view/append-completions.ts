// What the append composer's editor offers as you type, as pure functions over the draft's text: an
// event's four fields at the start of a mapping, and after `type:` the event types this context
// knows — the ones some processor here consumes, then the ones in the loaded log, most frequent
// first. The old platform's message composer completed `@` files and `/` commands the same way
// (apps/os `composer-completions.ts`, removed in #2837); the raw editor had none.
import type { CodeEditorCompletions } from "../code-editor.client.tsx";
import { shortEventType } from "./filters.tsx";

/** One event type the composer can offer, with why it is known. */
export type KnownEventType = { type: string; detail: string; section: string };

/** Every type a processor here consumes (wildcards name no one type) and every type in the log,
 *  each once: consumed first (by name), then the log's by count. */
export function knownEventTypes(
  counts: readonly [type: string, count: number][],
  processors: readonly { name: string; consumes?: readonly string[] }[],
): KnownEventType[] {
  const consumers = new Map<string, string[]>();
  for (const processor of processors)
    for (const type of processor.consumes || [])
      if (!type.includes("*"))
        consumers.set(type, [...(consumers.get(type) || []), processor.name]);
  const inLog = new Map(counts);
  const known: KnownEventType[] = [...consumers.keys()].sort().map((type) => ({
    type,
    section: "Consumed here",
    detail: `${consumers.get(type)!.join(", ")}${inLog.has(type) ? ` · ${inLogCount(inLog.get(type)!)}` : ""}`,
  }));
  for (const [type, count] of counts)
    if (!consumers.has(type))
      known.push({ type, section: "In the log", detail: inLogCount(count) });
  return known;
}

const inLogCount = (count: number) => `${count.toLocaleString()} in the log`;

const FIELDS = [
  { key: "type", detail: "the event type" },
  { key: "payload", detail: "a mapping" },
  { key: "metadata", detail: "a mapping" },
  { key: "idempotencyKey", detail: "appends once per key" },
] as const;

/** The completions at `pos` in the draft `text`, or null where there are none. `explicit` is a
 *  request (Ctrl+Space): a field name is offered on an empty line only then. */
export function appendCompletionsAt(
  text: string,
  pos: number,
  explicit: boolean,
  known: readonly KnownEventType[],
): CodeEditorCompletions | null {
  const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
  const before = text.slice(lineStart, pos);
  const typeValue = /^(?:\s*-\s+|\s*)type:\s*["']?([\w./@-]*)$/.exec(before);
  if (typeValue)
    return {
      from: pos - typeValue[1]!.length,
      validFor: /^[\w./@-]*$/,
      // CodeMirror sorts equal matches by label; the boost keeps this order (consumed, then by count)
      options: known.map(({ type, detail, section }, index) => ({
        label: type,
        boost: Math.max(-99, 99 - index),
        displayLabel: shortEventType(type),
        detail,
        section,
      })),
    };
  // a field starts a line of the one mapping, or of a list item (`- ` or its two-space continuation)
  const list = /^\s*-/.test(text);
  const field = (list ? /^(?:- | {2})([A-Za-z]*)$/ : /^([A-Za-z]*)$/).exec(before);
  if (!field || (!field[1] && !explicit)) return null;
  const indent = list ? "  " : "";
  // in one mapping, a field already written is not offered again
  const written = list ? new Set<string>() : new Set(text.match(/^[A-Za-z]+(?=:)/gm));
  return {
    from: pos - field[1]!.length,
    validFor: /^[A-Za-z]*$/,
    options: FIELDS.filter(({ key }) => !written.has(key)).map(({ key, detail }) => ({
      label: key,
      detail,
      apply: key === "payload" || key === "metadata" ? `${key}:\n${indent}  ` : `${key}: `,
    })),
  };
}
