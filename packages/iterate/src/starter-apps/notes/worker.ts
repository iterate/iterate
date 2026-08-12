// The NotesApp Durable Object: hosts the notes stream processor (including
// its analysis obligations — hence recovery) and exposes the query surface
// (search/list/get) that gets mounted at `itx.notes`. Search returns signed
// attachment URLs so an agent's answer can show a note's photos. No HTTP
// page — this app is an API, not a site.
import {
  StreamProcessorDurableObject,
  type ProcessorHostDeps,
  type StreamEvent,
} from "../../sdk.ts";
import { notesStreamPath } from "./app-ref.ts";
import { analyzeNoteText } from "./analysis.ts";
import { NotesProcessor, searchNotes, type NoteItem, type NotesState } from "./processor.ts";

export type NoteSearchHit = Omit<NoteItem, "attachments"> & {
  attachments: (NoteItem["attachments"][number] & {
    /** Signed https URL for the image — paste into chat to show it. */
    url: string;
  })[];
};

export class NotesApp extends StreamProcessorDurableObject<NotesState> {
  protected readonly streamPath = notesStreamPath;
  /** The processor owes background analysis work (the obligation pattern) —
   * an eviction mid-attempt must revive and settle, not drop it. */
  protected readonly recovery = true;

  protected createProcessor(deps: ProcessorHostDeps) {
    return new NotesProcessor({
      ...deps,
      now: () => Date.now(),
      analyze: async (input) => {
        using project = await this.env.ITX.get();
        return await analyzeNoteText(project.ai, input);
      },
    });
  }

  /** Project-worker event delivery calls this after a durable /notes event
   * commits. Catch-up owns validation, ordering, checkpointing, and dedupe. */
  async syncEvent(event: StreamEvent): Promise<void> {
    if (event.path !== notesStreamPath) return;
    const registry = await this.registry();
    await registry.catchUp("notes");
    registry.refreshLive();
  }

  /**
   * Keyword search over titles, note text, attachment filenames, and tags.
   * Every term must match; newest first; default limit 20.
   */
  async search(query: { q?: string; limit?: number }): Promise<NoteSearchHit[]> {
    const registry = await this.registry();
    await registry.catchUp("notes");
    const { state } = await this.snapshot();
    const hits = searchNotes(state, query);
    using project = await this.env.ITX.get();
    return await Promise.all(
      hits.map(async (note) => ({
        ...note,
        attachments: await Promise.all(
          note.attachments.map(async (attachment) => ({
            ...attachment,
            url: await project.files.get(attachment.path).url(),
          })),
        ),
      })),
    );
  }

  /** Newest notes, no filtering — `search` with an empty query. */
  async list(query: { limit?: number }): Promise<NoteSearchHit[]> {
    return this.search({ limit: query.limit });
  }

  /** One note by its noteKey, or null. */
  async get(noteKey: string): Promise<NoteItem | null> {
    const registry = await this.registry();
    await registry.catchUp("notes");
    const { state } = await this.snapshot();
    return state.notes[noteKey] || null;
  }
}
