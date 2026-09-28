// docs/processor.ts — ONE OPEN DOC (frames.ts): its text as a Y.Doc, the edits its browsers send,
// and its autosave. Git stays the source of truth; the Y.Doc is the session's buffer.
//
// THE Y.DOC lives in this facet's own SQLite: every update appended to `doc_updates` as it lands,
// folded into one after each save; `doc_meta` holds the commit the text was last saved as or read
// at (`base`) and who has edited since. A facet reset or an eviction loses nothing: the next call
// replays the table. The first open of a doc (no rows) reads the file at the repo's tip.
//
// AUTOSAVE: 1.5 s after the last edit (8 s at most while edits keep coming; durable-object.ts), a commit to
// /repos/docs whose parent is `base`, authored by the first person who edited since the last save,
// the others as `Co-authored-by:`. The repo refuses a parent that isn't its tip; then the tip's copy
// is merged in like git (merge.ts), the merge goes to every open browser as an edit frame, and the
// save is tried again. The same catch-up runs when a browser joins (`sync`) and when the root's
// docs processor says a commit changed the doc (`docs/commit-noticed`, root.ts), so a commit an
// agent made reaches the open editors without a reload.
import * as Y from "yjs";
import type { WithItx } from "iterate/sdk";
import { StreamProcessor, type ProcessEventArgs } from "iterate/stream/processor";
import { DocContract } from "./contract.ts";
import {
  COMMIT_NOTICED,
  DOCS_REPO,
  EDIT_FRAME,
  EditFrame,
  fromBase64,
  toBase64,
  type DocLiveState,
} from "./frames.ts";
import { mergeText, textEdits } from "./merge.ts";

type DocDeps = {
  sql: SqlStorage;
  /** The doc's context: `itx.repos` there is the root's (install.ts lends it by rule). */
  withItx: WithItx;
  /** The doc's path in /repos/docs. */
  path: string;
  /** Re-project the live state after a change outside a batch (the host's `publishLiveState`). */
  publishLiveState: () => void;
  /** When to save: `idleMs` after the last edit, and at most `maxMs` after the first unsaved one. */
  autosave: { idleMs: number; maxMs: number };
};

export class DocProcessor extends StreamProcessor<Record<string, never>> {
  contract = DocContract;
  readonly #deps: DocDeps;
  #doc: Y.Doc | null = null;
  #loading: Promise<Y.Doc> | null = null;
  /** The commit the text last matched, and its copy of the doc. */
  #base = { oid: "", text: "" };
  /** Who has edited since the last save, by email, in the order they started. */
  #editors = new Set<string>();
  #savedBy: string[] = [];
  #saveError: string | null = null;
  #firstEditAt = 0;
  #lastEditAt = 0;
  #saveScheduled = false;
  /** Saves and catch-ups run one at a time: each reads `base` before an await and writes it after. */
  #serial: Promise<unknown> = Promise.resolve();

  constructor(deps: DocDeps) {
    super();
    this.#deps = deps;
    deps.sql.exec(
      "CREATE TABLE IF NOT EXISTS doc_updates (seq INTEGER PRIMARY KEY AUTOINCREMENT, data BLOB NOT NULL)",
    );
    deps.sql.exec(
      "CREATE TABLE IF NOT EXISTS doc_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
  }

  override projectLiveState(): DocLiveState {
    return {
      commitOid: this.#base.oid || null,
      dirty: this.#dirty(),
      savedBy: this.#savedBy,
      saveError: this.#saveError,
    };
  }

  override processEvent({
    event,
    blockProcessorWhile,
    runInBackground,
  }: ProcessEventArgs<Record<string, never>>): undefined {
    // The at-head pass, after a reset or a revive: edits the last incarnation hadn't saved yet.
    if (!event) {
      blockProcessorWhile(async () => {
        await this.#load();
        if (this.#dirty()) this.#scheduleSave(runInBackground);
      });
      return;
    }
    if (event.type === COMMIT_NOTICED) {
      blockProcessorWhile(async () => {
        await this.#load();
        await this.#exclusive(() => this.#catchUp());
      });
      return;
    }
    if (event.type !== EDIT_FRAME) return;
    const frame = EditFrame.safeParse(event.payload);
    // the processor's own frames come back to it: already applied
    if (!frame.success || frame.data.client === "processor") return;
    const editor = event.source.principal?.email;
    blockProcessorWhile(async () => {
      const doc = await this.#load();
      Y.applyUpdate(doc, fromBase64(frame.data.update), "browser");
      if (!this.#dirty()) return;
      if (editor && !this.#editors.has(editor)) {
        this.#editors.add(editor);
        this.#writeMeta();
      }
      this.#scheduleSave(runInBackground);
    });
  }

  /** A browser joining: the processor's state past `stateVector` (base64), after taking in any
   *  commit made since the last sync, and its own state vector, for the browser to send back what
   *  the processor lacks. */
  async sync(stateVector: string) {
    const doc = await this.#load();
    await this.#exclusive(() => this.#catchUp());
    return {
      update: toBase64(Y.encodeStateAsUpdate(doc, fromBase64(stateVector))),
      stateVector: toBase64(Y.encodeStateVector(doc)),
      commitOid: this.#base.oid,
    };
  }

  #text() {
    return this.#doc ? this.#doc.getText("file").toString() : this.#base.text;
  }

  #dirty() {
    return this.#text() !== this.#base.text;
  }

  #load(): Promise<Y.Doc> {
    this.#loading ||= this.#loadOnce();
    return this.#loading;
  }

  async #loadOnce() {
    const { sql } = this.#deps;
    const doc = new Y.Doc();
    const updates = sql
      .exec<{ data: ArrayBuffer }>("SELECT data FROM doc_updates ORDER BY seq")
      .toArray();
    for (const row of updates) Y.applyUpdate(doc, new Uint8Array(row.data));
    // from here on every update is kept, the first read's included
    doc.on("update", (update: Uint8Array) => {
      sql.exec("INSERT INTO doc_updates (data) VALUES (?)", update);
    });
    const meta = Object.fromEntries(
      sql
        .exec<{ key: string; value: string }>("SELECT key, value FROM doc_meta")
        .toArray()
        .map((row) => [row.key, row.value]),
    );
    if (updates.length > 0) {
      this.#base = { oid: meta.baseOid || "", text: meta.baseText || "" };
      this.#editors = new Set(JSON.parse(meta.editors || "[]"));
      this.#savedBy = JSON.parse(meta.savedBy || "[]");
    } else {
      const { tip, text } = await this.#deps.withItx(async (itx) => {
        const repo = itx.repos.get(DOCS_REPO);
        const tip = await repo.tip();
        return { tip, text: tip ? await repo.readFile(this.#deps.path, { commitOid: tip }) : null };
      });
      this.#base = { oid: tip || "", text: text || "" };
      doc.getText("file").insert(0, this.#base.text);
      this.#writeMeta();
    }
    this.#doc = doc;
    return doc;
  }

  #writeMeta() {
    const entries = {
      baseOid: this.#base.oid,
      baseText: this.#base.text,
      editors: JSON.stringify([...this.#editors]),
      savedBy: JSON.stringify(this.#savedBy),
    };
    for (const [key, value] of Object.entries(entries))
      this.#deps.sql.exec(
        "INSERT INTO doc_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        key,
        value,
      );
  }

  #exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#serial.then(work);
    this.#serial = run.catch(() => {});
    return run;
  }

  #scheduleSave(runInBackground: (work: () => Promise<unknown>) => void) {
    const now = Date.now();
    this.#lastEditAt = now;
    this.#firstEditAt ||= now;
    if (this.#saveScheduled) return;
    this.#saveScheduled = true;
    this.#deps.publishLiveState();
    runInBackground(async () => {
      const { idleMs, maxMs } = this.#deps.autosave;
      try {
        for (
          let wait = idleMs;
          wait > 0;
          wait = Math.min(this.#lastEditAt + idleMs, this.#firstEditAt + maxMs) - Date.now()
        )
          await new Promise((resolve) => setTimeout(resolve, wait));
      } finally {
        this.#saveScheduled = false;
        this.#firstEditAt = 0;
      }
      await this.#exclusive(() => this.#save());
    });
  }

  /** Commit the text with `base` as its parent; refused because someone else committed, take
   *  their commit in and commit the merge on top of it. */
  async #save(): Promise<void> {
    const text = this.#text();
    if (text === this.#base.text) return;
    const editors = [...this.#editors];
    const { path } = this.#deps;
    try {
      const result = await this.#deps.withItx((itx) =>
        itx.repos.get(DOCS_REPO).commitFiles({
          // git's trailers, after a blank line: everyone but the author
          message: [
            `docs: edit ${path}`,
            ...(editors.length > 1 ? [""] : []),
            ...editors.slice(1).map((editor) => `Co-authored-by: ${editor} <${editor}>`),
          ].join("\n"),
          changes: [{ path, content: text }],
          parent: this.#base.oid || null,
          author: editors[0] ? { name: editors[0], email: editors[0] } : undefined,
        }),
      );
      this.#base = { oid: result.commitOid || this.#base.oid, text };
      this.#savedBy = editors;
      this.#saveError = null;
      for (const editor of editors) this.#editors.delete(editor);
      this.#compact();
    } catch (error) {
      // anything but main having moved is a real failure; the next edit or at-head pass retries
      if (!(await this.#catchUp())) {
        this.#saveError = error instanceof Error ? error.message : String(error);
        throw error;
      }
      return this.#save();
    } finally {
      this.#writeMeta();
      this.#deps.publishLiveState();
    }
  }

  /** Take in the repo's tip when it moved past `base`: ours (the live text) and theirs (the tip's
   *  copy) merged over base, applied as small edits and sent to the open browsers. False when the
   *  tip is `base`. */
  async #catchUp(): Promise<boolean> {
    const { path } = this.#deps;
    const { tip, theirs } = await this.#deps.withItx(async (itx) => {
      const repo = itx.repos.get(DOCS_REPO);
      const tip = await repo.tip();
      return {
        tip,
        theirs:
          tip && tip !== this.#base.oid ? await repo.readFile(path, { commitOid: tip }) : null,
      };
    });
    if (!tip || tip === this.#base.oid) return false;
    const ours = this.#text();
    // the file deleted at the tip: keep the live text, which the next save writes back
    // oxlint-disable-next-line iterate/simple-truthiness-check -- an emptied file is "" and merges like any edit; only a deleted one is null
    const theirsText = theirs === null ? ours : theirs;
    const merged =
      ours === this.#base.text ? theirsText : mergeText(ours, this.#base.text, theirsText).text;
    const update = this.#replaceText(ours, merged);
    this.#base = { oid: tip, text: theirsText };
    this.#writeMeta();
    if (update)
      await this.#deps.withItx((itx) =>
        itx.append({
          type: EDIT_FRAME,
          ephemeral: true,
          payload: { update: toBase64(update), client: "processor" },
        }),
      );
    this.#deps.publishLiveState();
    return true;
  }

  /** Turn the live text from `from` into `to` in one transaction; the update it made, if any. */
  #replaceText(from: string, to: string): Uint8Array | null {
    const doc = this.#doc!;
    const text = doc.getText("file");
    const edits = textEdits(from, to);
    if (edits.length === 0) return null;
    let made: Uint8Array | null = null;
    const keep = (update: Uint8Array) => {
      made = update;
    };
    doc.on("update", keep);
    doc.transact(() => {
      for (const edit of edits) {
        if ("insert" in edit) text.insert(edit.at, edit.insert);
        else text.delete(edit.at, edit.delete);
      }
    }, "processor");
    doc.off("update", keep);
    return made;
  }

  /** After a save: the updates table as one update, the whole doc. */
  #compact() {
    const state = Y.encodeStateAsUpdate(this.#doc!);
    this.#deps.sql.exec("DELETE FROM doc_updates");
    this.#deps.sql.exec("INSERT INTO doc_updates (data) VALUES (?)", state);
  }
}
