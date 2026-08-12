// Notes capture: pure logic only (no Expo imports), so vitest covers it in
// root CI. The global composer (components/note-composer.tsx) and the notes
// screen (app/project/[projectId]/notes.tsx) wire this to the picker and itx.
// Flow: the composer appends a notes/captured event directly (capture is
// instant and dumb — no AI in the path); the userland NotesApp processor
// (packages/iterate/src/starter-apps/notes) settles a title/tags analysis
// obligation with notes/analysis-settled, which the list derivation overlays.
// Photo attachments double-append onto /media with source "note" so the
// media pipeline analyzes them for free (grill decision D7).

import type { StreamEvent } from "iterate/sdk/itx/react";

export const NOTES_STREAM_PATH = "/notes";
export const NOTE_CAPTURED_EVENT_TYPE = "events.iterate.com/notes/captured";
export const NOTE_ANALYSIS_SETTLED_EVENT_TYPE = "events.iterate.com/notes/analysis-settled";
export const NOTE_REANALYZE_EVENT_TYPE = "events.iterate.com/notes/reanalyze-requested";
export const NOTE_DELETED_EVENT_TYPE = "events.iterate.com/notes/deleted";
export const NOTE_EVENT_TYPES = [
  NOTE_CAPTURED_EVENT_TYPE,
  NOTE_ANALYSIS_SETTLED_EVENT_TYPE,
  NOTE_DELETED_EVENT_TYPE,
];

export type NoteAttachment = {
  /** itx.files path holding the bytes — mediaFilePath shape, shared with /media. */
  path: string;
  filename: string;
  contentType: string;
  width: number;
  height: number;
};

export type NoteCapturedPayload = {
  noteKey: string;
  text: string;
  attachments: NoteAttachment[];
  /** When the note was typed (ISO) — predates the append for drained pending notes. */
  capturedOnDeviceAt: string | null;
};

export type NoteAnalysisSettledPayload = {
  noteKey: string;
  requestOffset: number;
  result:
    | { status: "succeeded"; title: string; tags: string[]; processedBy: string }
    | { status: "failed"; error: string };
};

/** Client-minted note identity; the caller supplies time + entropy so this
 * stays a pure function. */
export function newNoteKey(nowMs: number, entropy: string): string {
  return `${nowMs.toString(36)}-${entropy}`;
}

export function buildCapturedEvent(payload: NoteCapturedPayload) {
  return {
    type: NOTE_CAPTURED_EVENT_TYPE,
    // Keyed by the note's identity so a retried append (flaky network,
    // double-tapped send, a re-drained pending note) folds to one note.
    idempotencyKey: `notes-captured-${payload.noteKey}`,
    payload,
  };
}

export function buildDeletedEvent(noteKey: string) {
  return {
    type: NOTE_DELETED_EVENT_TYPE,
    // Per-note, not per-invocation: deleting twice is one tombstone.
    idempotencyKey: `notes-deleted-${noteKey}`,
    payload: { noteKey },
  };
}

export function buildReanalyzeEvent(noteKey: string, nonce: string) {
  return {
    type: NOTE_REANALYZE_EVENT_TYPE,
    // Each deliberate re-run is its own fact.
    idempotencyKey: `notes-reanalyze-${noteKey}-${nonce}`,
    payload: { noteKey },
  };
}

export type NoteListItem = {
  /** The captured event's offset — the row's identity in the list. */
  offset: number;
  capturedEventAt: string;
  payload: NoteCapturedPayload;
  /** Model-derived title ("" until analysis settles). */
  title: string;
  tags: string[];
  analysisError: string;
  /** Derived title, or the text's first line while analysis is pending/failed. */
  displayTitle: string;
};

export function noteFirstLine(text: string): string {
  return (text.split("\n").find((line) => line.trim() !== "") || "").trim().slice(0, 80);
}

/**
 * Captured events → list items, newest first, with the latest
 * analysis-settled success overlaid per noteKey and deleted tombstones
 * removed — the same fold the server's NotesProcessor runs.
 */
export function deriveNotesList(events: StreamEvent[]): NoteListItem[] {
  const notes = new Map<string, NoteListItem>();
  for (const event of events) {
    // Events arrive offset-ascending, so later facts win by iteration order.
    if (event.type === NOTE_CAPTURED_EVENT_TYPE) {
      const payload = event.payload as NoteCapturedPayload;
      if (notes.has(payload.noteKey)) continue;
      notes.set(payload.noteKey, {
        offset: event.offset,
        capturedEventAt: event.createdAt,
        payload: { ...payload, attachments: payload.attachments || [] },
        title: "",
        tags: [],
        analysisError: "",
        displayTitle: noteFirstLine(payload.text),
      });
    } else if (event.type === NOTE_ANALYSIS_SETTLED_EVENT_TYPE) {
      const payload = event.payload as NoteAnalysisSettledPayload;
      const note = notes.get(payload.noteKey);
      if (note === undefined) continue;
      if (payload.result.status === "succeeded") {
        notes.set(payload.noteKey, {
          ...note,
          title: payload.result.title,
          tags: payload.result.tags,
          analysisError: "",
          displayTitle: payload.result.title || noteFirstLine(note.payload.text),
        });
      } else {
        notes.set(payload.noteKey, { ...note, analysisError: payload.result.error });
      }
    } else if (event.type === NOTE_DELETED_EVENT_TYPE) {
      notes.delete((event.payload as { noteKey: string }).noteKey);
    }
  }
  return [...notes.values()].sort((a, b) => b.offset - a.offset);
}

/**
 * Every whitespace-separated query term must appear in the title, text,
 * attachment filenames, or tags. Kept in sync by hand with the server's
 * searchNotes (starter-apps/notes/processor.ts) — the two runtimes can't
 * share a module yet.
 */
export function filterNotes(items: NoteListItem[], query: string): NoteListItem[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((item) => {
    const haystack =
      `${item.title} ${item.payload.text} ${item.payload.attachments.map((a) => a.filename).join(" ")} ${item.tags.join(" ")}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

/** Read every note event, paging like lib/media.ts readAllMediaEvents. */
export async function readAllNoteEvents(stream: {
  getEvents: (args: { afterOffset: number; eventTypes: string[] }) => Promise<StreamEvent[]>;
}): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  let cursor = 0;
  while (true) {
    const page = await stream.getEvents({ afterOffset: cursor, eventTypes: NOTE_EVENT_TYPES });
    if (page.length === 0) return events;
    events.push(...page);
    cursor = page.at(-1)!.offset;
  }
}
