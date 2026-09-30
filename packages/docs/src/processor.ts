// docs/processor.ts — ONE OPEN DOC (frames.ts): its text as a Y.Doc, the edits its browsers send,
// and its autosave. Git stays the source of truth; the Y.Doc is the session's buffer, and an edit is
// safe once it's here (the table below), so commits can be few.
//
// THE Y.DOC lives in this facet's own SQLite: every update appended to `doc_updates` as it lands,
// folded into one after each save; `doc_meta` holds the commit the text was last saved as or read
// at (`base`) and who has edited since. A facet reset or an eviction loses nothing: the next call
// replays the table. The first open of a doc (no rows) reads the file at the repo's tip.
//
// AUTOSAVE: a minute after the first unsaved edit (durable-object.ts), or at once when the last open
// tab leaves (`docs/left`; a tab is here from its `sync` or its first edit), a commit to the doc's
// repo whose parent is `base`, authored by the first person who edited since the last save, the
// others as `Co-authored-by:`. A repo like /repos/config republishes the project's site on each
// commit, so a burst of typing is one commit, not one per pause. The repo refuses a parent that isn't its tip; then the tip's copy
// is merged in like git (merge.ts), the merge goes to every open browser as an edit frame, and the
// save is tried again. The same catch-up runs when a browser joins (`sync`) and when the root's
// docs processor says a commit changed the doc (`docs/commit-noticed`, root.ts), so a commit an
// agent made reaches the open editors without a reload.
//
// COMMENTS (comments.ts) are reduced into the processor's state, and so into its live state. After
// each save and each catch-up the processor finds every thread's quote in the new text (anchor.ts)
// and appends `docs/comment-reanchored` for one that now matches only loosely (the quote refreshed
// to the text it matches), matches nothing (detached), or matches again after being detached.
import * as Y from "yjs";
import type { IterateContextApi } from "iterate/api";
import {
  StreamProcessor,
  type ProcessEventArgs,
  type ProcessorState,
  type ReduceArgs,
} from "iterate/stream/processor";
import { findQuote, quoteAt } from "./anchor.ts";
import { COMMENT_REANCHORED, reduceComments, type CommentThread } from "./comments.ts";
import { DocContract } from "./contract.ts";
import {
  COMMIT_NOTICED,
  DOC_LEFT,
  DocLeft,
  docOf,
  EDIT_FRAME,
  EditFrame,
  fromBase64,
  toBase64,
  type DocLiveState,
  type DocRef,
} from "./frames.ts";
import { mergeText, textEdits } from "./merge.ts";

type DocState = ProcessorState<typeof DocContract>;

type DocDeps = {
  sql: SqlStorage;
  /** The doc's context, `/docs/<repo name>/<path>` (its `whoami()` names the doc). The repos
   *  are the root's (`itx.cd("/").repos`), which loaded code reaches from anywhere in its project. */
  getItx: () => IterateContextApi & Disposable;
  /** Re-project the live state after a change outside a batch (the host's `publishLiveState`). */
  publishLiveState: () => void;
  /** When to save: `idleMs` after the last edit, and at most `maxMs` after the first unsaved one. */
  autosave: { idleMs: number; maxMs: number };
};

export class DocProcessor extends StreamProcessor<DocState> {
  contract = DocContract;
  readonly #deps: DocDeps;
  #doc: Y.Doc | null = null;
  /** The doc's repo and path, from the context's own path as the doc loads. */
  #ref: DocRef = { repo: "", path: "" };
  /** The tabs with the doc open, by Yjs client id; when the last one leaves, the doc saves. */
  #present = new Set<number>();
  #loading: Promise<Y.Doc> | null = null;
  /** The commit the text last matched, and its copy of the doc. */
  #base = { oid: "", text: "" };
  /** Who has edited since the last save, by email, in the order they started. */
  #editors = new Set<string>();
  #savedBy: string[] = [];
  #saveError: string | null = null;
  /** The threads as last reduced, for re-anchoring after a save. */
  #threads: CommentThread[] = [];
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

  override reduce({ event, state }: ReduceArgs<DocState>): DocState | undefined {
    const threads = reduceComments(state.threads, event);
    if (threads !== state.threads) return { ...state, threads };
  }

  override projectLiveState(state: DocState): DocLiveState {
    return {
      commitOid: this.#base.oid || null,
      dirty: this.#dirty(),
      savedBy: this.#savedBy,
      saveError: this.#saveError,
      threads: state.threads,
    };
  }

  override processEvent({
    event,
    state,
    delivery,
    blockProcessorWhile,
    runInBackground,
  }: ProcessEventArgs<DocState>): undefined {
    this.#threads = state.threads;
    // At the head (the eventless pass, or the last event of a batch that reaches it), after a
    // reset or a revive: the doc loaded, so the live state has its commit even when only comments
    // arrive, and what the last incarnation hadn't saved yet is saved.
    if (delivery.caughtUp)
      blockProcessorWhile(async () => {
        await this.#load();
        // an edit's own timer stands: this isn't an edit
        if (this.#dirty() && !this.#saveScheduled) this.#scheduleSave(runInBackground);
      });
    if (!event) return;
    if (event.type === COMMIT_NOTICED) {
      blockProcessorWhile(async () => {
        await this.#load();
        await this.#exclusive(() => this.#catchUp());
      });
      return;
    }
    if (event.type === DOC_LEFT) {
      const left = DocLeft.safeParse(event.payload);
      if (!left.success) return;
      this.#present.delete(left.data.client);
      // the last tab gone: what's unsaved is saved now, not a minute from now
      if (this.#present.size === 0)
        runInBackground(async () => {
          await this.#load();
          await this.#exclusive(() => this.#save());
        });
      return;
    }
    if (event.type !== EDIT_FRAME) return;
    const frame = EditFrame.safeParse(event.payload);
    // the processor's own frames come back to it: already applied
    if (!frame.success || frame.data.client === "processor") return;
    this.#present.add(frame.data.client);
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

  /** A browser joining, or syncing again: `client` (its Yjs client id) is here until it sends
   *  `docs/left`. Answers the processor's state past `stateVector` (base64), after taking in any
   *  commit made since the last sync, and its own state vector, for the browser to send back what
   *  the processor lacks. */
  async sync(stateVector: string, client: number) {
    this.#present.add(client);
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
    {
      using itx = this.#deps.getItx();
      this.#ref = docOf((await itx.whoami()).path);
    }
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
      using itx = this.#deps.getItx();
      const repo = itx.cd("/").repos.get(this.#ref.repo);
      const tip = await repo.tip();
      const text = tip ? await repo.readFile(this.#ref.path, { commitOid: tip }) : null;
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
    const { repo, path } = this.#ref;
    try {
      using itx = this.#deps.getItx();
      const result = await itx
        .cd("/")
        .repos.get(repo)
        .commitFiles({
          // git's trailers, after a blank line: everyone but the author
          message: [
            `docs: edit ${path}`,
            ...(editors.length > 1 ? [""] : []),
            ...editors.slice(1).map((editor) => `Co-authored-by: ${editor} <${editor}>`),
          ].join("\n"),
          changes: [{ path, content: text }],
          parent: this.#base.oid || null,
          author: editors[0] ? { name: editors[0], email: editors[0] } : undefined,
        });
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
    await this.#reanchor(text);
  }

  /** Take in the repo's tip when it moved past `base`: ours (the live text) and theirs (the tip's
   *  copy) merged over base, applied as small edits and sent to the open browsers. False when the
   *  tip is `base`. */
  async #catchUp(): Promise<boolean> {
    const { path } = this.#ref;
    let tip: string | null;
    let theirs: string | null = null;
    {
      using itx = this.#deps.getItx();
      const repo = itx.cd("/").repos.get(this.#ref.repo);
      tip = await repo.tip();
      if (tip && tip !== this.#base.oid) theirs = await repo.readFile(path, { commitOid: tip });
    }
    if (!tip || tip === this.#base.oid) return false;
    const ours = this.#text();
    const unsaved = ours !== this.#base.text;
    // the file deleted at the tip: the live text stays in the open tabs; a delete of a doc with no
    // unsaved edits stands (until someone edits it again), and unsaved edits are dirty against a
    // base of nothing, so the next save writes the doc back with them
    // oxlint-disable-next-line iterate/simple-truthiness-check -- only a deleted file is null; an emptied one is "" and merges like any edit
    const deleted = theirs === null;
    const theirsText = deleted ? ours : theirs || "";
    const merged = unsaved ? mergeText(ours, this.#base.text, theirsText).text : theirsText;
    const update = this.#replaceText(ours, merged);
    this.#base = { oid: tip, text: deleted && unsaved ? "" : theirsText };
    this.#writeMeta();
    if (update) {
      using itx = this.#deps.getItx();
      await itx.append({
        type: EDIT_FRAME,
        ephemeral: true,
        payload: { update: toBase64(update), client: "processor" },
      });
    }
    this.#deps.publishLiveState();
    await this.#reanchor(merged);
    return true;
  }

  /** Each thread's quote found in `text`: refreshed where only its surroundings matched, detached
   *  where nothing did, attached again where a detached one matches. An exact match changes nothing. */
  async #reanchor(text: string) {
    const events = this.#threads.flatMap((thread) => {
      if (!thread.quote) return [];
      const found = findQuote(text, thread.quote);
      if (found?.exact && !thread.detached) return [];
      if (!found && thread.detached) return [];
      // a repeat (two saves before the first's event is reduced) sets the same quote again
      const quote = found && quoteAt(text, found.from, found.to);
      return [{ type: COMMENT_REANCHORED, payload: { thread: thread.id, quote } }];
    });
    if (events.length === 0) return;
    using itx = this.#deps.getItx();
    await itx.append(...events);
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
