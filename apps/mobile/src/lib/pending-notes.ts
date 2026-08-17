// The local "pending notes" store: captures made outside a project (sign-in,
// projects list) or that failed to append (offline, server error) wait here
// — text plus attachment base64 blobs — until a drain prompt stores them
// into a project (grill decisions D4/D5). Pure logic over an injected
// AsyncStorage-shaped seam so vitest covers it in root CI; the composer
// passes the real @react-native-async-storage/async-storage.

export type PendingNoteAttachment = {
  filename: string;
  contentType: string;
  /** Base64 payload, exactly as picked — uploaded at drain time. */
  base64: string;
  width: number;
  height: number;
};

export type PendingNote = {
  noteKey: string;
  text: string;
  capturedOnDeviceAt: string;
  attachments: PendingNoteAttachment[];
};

/** The AsyncStorage slice this store needs. */
export type PendingNotesStorage = {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
};

export const PENDING_NOTES_STORAGE_KEY = "iterate.pendingNotes";

export async function readPendingNotes(storage: PendingNotesStorage): Promise<PendingNote[]> {
  const raw = await storage.getItem(PENDING_NOTES_STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (note: any) => typeof note?.noteKey === "string" && typeof note?.text === "string",
    );
  } catch {
    return [];
  }
}

export async function addPendingNote(
  storage: PendingNotesStorage,
  note: PendingNote,
): Promise<void> {
  const notes = await readPendingNotes(storage);
  // noteKey is the capture's identity: a retried save must not duplicate it.
  if (notes.some((existing) => existing.noteKey === note.noteKey)) return;
  await storage.setItem(PENDING_NOTES_STORAGE_KEY, JSON.stringify([...notes, note]));
}

export async function removePendingNotes(
  storage: PendingNotesStorage,
  noteKeys: string[],
): Promise<void> {
  const notes = await readPendingNotes(storage);
  await storage.setItem(
    PENDING_NOTES_STORAGE_KEY,
    JSON.stringify(notes.filter((note) => !noteKeys.includes(note.noteKey))),
  );
}

/**
 * Store every pending note into the target project, oldest first, removing
 * each from the store AS it lands — an interruption (crash, offline again)
 * keeps the not-yet-stored tail pending. `store` is the composer's
 * appendNoteToProject; failures stop the drain and report what remains.
 */
export async function drainPendingNotes(
  storage: PendingNotesStorage,
  store: (note: PendingNote) => Promise<void>,
): Promise<{ stored: number; remaining: number; error: string | null }> {
  const notes = await readPendingNotes(storage);
  let stored = 0;
  for (const note of notes) {
    try {
      await store(note);
    } catch (error) {
      return {
        stored,
        remaining: notes.length - stored,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    await removePendingNotes(storage, [note.noteKey]);
    stored += 1;
  }
  return { stored, remaining: 0, error: null };
}
