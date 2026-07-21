import { ChangeSet, Text } from "@codemirror/state";

/**
 * Attributed tracked changes — a PURE fold of the collab op log.
 *
 * Given the document at a base version and the accepted ops since, produce
 * redline segments in CURRENT-document coordinates:
 *
 * - `inserted` spans: text that did not exist at the base, tagged with the
 *   clientId that typed it. Deleting fresh text (yours or anyone's) simply
 *   shrinks its span — it never was a change against the base.
 * - `deleted` markers: BASE text that no longer exists, carrying the deleted
 *   text itself (recovered from the intermediate docs the fold necessarily
 *   visits), positioned where it vanished.
 *
 * An "edit" in the Google-Docs sense is a deletion and an insertion at one
 * site — renderers pair adjacent segments when they want that framing.
 *
 * No engine state, no storage: retention policy (which ops still exist) is
 * the store's business; orchestration (what the base is) is the host's.
 */

export type CollabChangeSegment =
  | { clientId: string; createdAt?: number; from: number; kind: "inserted"; to: number }
  | { at: number; clientId: string; createdAt?: number; kind: "deleted"; text: string };

type InsertedSpan = { clientId: string; createdAt?: number; from: number; to: number };

export function attributedChanges(
  base: Text,
  ops: { changes: unknown; clientId: string; createdAt?: number }[],
): CollabChangeSegment[] {
  let doc = base;
  let inserted: InsertedSpan[] = [];
  let deleted: { at: number; clientId: string; createdAt?: number; text: string }[] = [];

  for (const op of ops) {
    const changes = ChangeSet.fromJSON(op.changes);
    const ranges: { fromA: number; fromB: number; toA: number; toB: number }[] = [];
    changes.iterChanges((fromA, toA, fromB, toB) => ranges.push({ fromA, fromB, toA, toB }));

    // Base-text deletions: the removed range MINUS every fresh-inserted span.
    // (Coordinates here are pre-op; the removed text collapses to fromB in
    // post-op coordinates.)
    const newDeletes = ranges.flatMap((range) =>
      subtract([range.fromA, range.toA], inserted).map(([from, to]) => ({
        at: range.fromB,
        clientId: op.clientId,
        createdAt: op.createdAt,
        text: doc.sliceString(from, to),
      })),
    );

    // Carry every existing segment into post-op coordinates. from/to hug the
    // surviving text (assoc 1/-1), so overlapping deletions truncate spans
    // and full coverage collapses them away. An insertion landing STRICTLY
    // INSIDE a carried span stretches it over foreign text — subtract this
    // op's own inserted ranges so every character keeps its true author.
    const opInserts: InsertedSpan[] = ranges
      .filter((range) => range.toB > range.fromB)
      .map((range) => ({
        clientId: op.clientId,
        createdAt: op.createdAt,
        from: range.fromB,
        to: range.toB,
      }));
    inserted = inserted
      .map((span) => ({
        clientId: span.clientId,
        createdAt: span.createdAt,
        from: changes.mapPos(span.from, 1),
        to: changes.mapPos(span.to, -1),
      }))
      .filter((span) => span.from < span.to)
      .flatMap((span) =>
        subtract([span.from, span.to], opInserts).map(([from, to]) => ({
          clientId: span.clientId,
          createdAt: span.createdAt,
          from,
          to,
        })),
      );
    deleted = deleted.map((span) => ({ ...span, at: changes.mapPos(span.at, -1) }));
    deleted.push(...newDeletes);

    ranges.forEach((range) => {
      if (range.toB > range.fromB) {
        inserted.push({
          clientId: op.clientId,
          createdAt: op.createdAt,
          from: range.fromB,
          to: range.toB,
        });
      }
    });
    doc = changes.apply(doc);
  }

  const position = (segment: CollabChangeSegment) =>
    segment.kind === "inserted" ? segment.from : segment.at;
  return [
    ...coalesce(inserted).map((span) => ({ ...span, kind: "inserted" as const })),
    ...deleted
      .filter((span) => span.text.length > 0)
      .map((span) => ({ ...span, kind: "deleted" as const })),
  ].sort(
    // Position order; at a tie (a replace), the deletion renders first —
    // struck-out old text, then the new text, redline convention.
    (left, right) =>
      position(left) - position(right) ||
      (left.kind === "deleted" ? -1 : 0) - (right.kind === "deleted" ? -1 : 0),
  );
}

/** [from, to) minus the union of the spans (any author — fresh is fresh). */
function subtract(range: [number, number], spans: InsertedSpan[]): [number, number][] {
  let remaining: [number, number][] = [range];
  for (const span of spans) {
    remaining = remaining.flatMap(([from, to]) => {
      if (span.to <= from || span.from >= to) return [[from, to]];
      const kept: [number, number][] = [];
      if (span.from > from) kept.push([from, span.from]);
      if (span.to < to) kept.push([span.to, to]);
      return kept;
    });
  }
  return remaining.filter(([from, to]) => from < to);
}

/** Merge touching same-author spans (contiguous typing = one segment). */
function coalesce(spans: InsertedSpan[]): InsertedSpan[] {
  const sorted = [...spans].sort((left, right) => left.from - right.from);
  const merged: InsertedSpan[] = [];
  for (const span of sorted) {
    const last = merged.at(-1);
    if (last && last.clientId === span.clientId && span.from <= last.to) {
      last.to = Math.max(last.to, span.to);
      // Coalesced spans wear the LATEST touch time.
      if ((span.createdAt ?? 0) > (last.createdAt ?? 0)) last.createdAt = span.createdAt;
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}
