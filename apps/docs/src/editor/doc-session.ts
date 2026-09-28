// One open doc: its editor and its autosave. The page reads `state()` through
// useSyncExternalStore; everything that changes it happens here.
//
// AUTOSAVE is a commit to /repos/docs with the commit the editor last synced with as its parent,
// 1.5 s after the last keystroke (8 s at most while typing continues). The repo refuses a parent
// that isn't its tip, so a save never lands on top of a commit it hasn't seen: on a refusal the
// session reads the tip's copy, merges it into the editor like git would (merge.ts), and saves the
// merge. (tasks/docs-app.md part 2 moves this into the doc's own server, for co-editing.)
import { Compartment, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { RepoHandle } from "iterate/api";
import { docEditorExtensions, previewExtensions, type EditorMode } from "./extensions.ts";
import { mergeText, textChanges } from "./merge.ts";

export type SaveStatus =
  | { kind: "saved"; oid: string; mergedConflicts: number | null }
  | { kind: "editing" }
  | { kind: "saving" }
  | { kind: "failed"; message: string };

export type DocSessionState = { mode: EditorMode; status: SaveStatus };

type Repo = Pick<RepoHandle, "commitFiles" | "readFile" | "tip">;

type DocSessionOptions = {
  path: string;
  /** the commit the doc was read at, and its text there */
  oid: string;
  text: string;
  author: { name: string; email: string } | undefined;
  /** Runs `work` with the docs repo's handle, disposed after. */
  withRepo: <T>(work: (repo: Repo) => Promise<T>) => Promise<T>;
};

export class DocSession {
  #state: DocSessionState;
  #listeners = new Set<() => void>();
  #preview = new Compartment();
  #view: EditorView | null = null;
  /** The text while there's no view: the doc as read, then what the view had when it went (what
   *  a save after leaving the page commits). */
  #detachedText: string;
  /** The commit the editor's text last matched, and its copy of the doc. */
  #base: { oid: string; text: string };
  #idleTimer: ReturnType<typeof setTimeout> | undefined;
  #dirtySince = 0;
  #saving: Promise<void> | null = null;
  #saveAgain = false;

  options: DocSessionOptions;

  constructor(options: DocSessionOptions) {
    this.options = options;
    this.#base = { oid: options.oid, text: options.text };
    this.#detachedText = options.text;
    this.#state = {
      mode: "rich",
      status: { kind: "saved", oid: options.oid, mergedConflicts: null },
    };
  }

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  state = () => this.#state;

  #set(patch: Partial<DocSessionState>) {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener();
  }

  /** The editor's element, as a React ref: the view lives while it's mounted. Leaving the page
   *  saves what's unsaved; closing the tab with unsaved text asks first. */
  mount = (parent: HTMLDivElement | null) => {
    if (!parent) return;
    const view = new EditorView({
      parent,
      doc: this.#base.text,
      extensions: [
        docEditorExtensions({
          mode: this.#state.mode,
          preview: this.#preview,
          onDocChanged: (text) => this.#changed(text),
        }),
        // the text box is named by the file it edits
        EditorView.contentAttributes.of({ "aria-label": this.options.path }),
      ],
    });
    this.#view = view;
    const warnIfUnsaved = (event: BeforeUnloadEvent) => {
      if (this.#state.status.kind !== "saved") event.preventDefault();
    };
    window.addEventListener("beforeunload", warnIfUnsaved);
    return () => {
      window.removeEventListener("beforeunload", warnIfUnsaved);
      this.#detachedText = view.state.doc.toString();
      this.#view = null;
      view.destroy();
      void this.save();
    };
  };

  setMode(mode: EditorMode) {
    this.#view?.dispatch({ effects: this.#preview.reconfigure(previewExtensions(mode)) });
    this.#set({ mode });
    this.#view?.focus();
  }

  /** Run a formatting command (commands.ts) on the editor. */
  run(command: (view: EditorView) => boolean) {
    if (this.#view) command(this.#view);
  }

  #text() {
    return this.#view ? this.#view.state.doc.toString() : this.#detachedText;
  }

  #changed(text: string) {
    if (text === this.#base.text && !this.#saving) {
      clearTimeout(this.#idleTimer);
      this.#dirtySince = 0;
      this.#set({ status: { kind: "saved", oid: this.#base.oid, mergedConflicts: null } });
      return;
    }
    if (this.#state.status.kind !== "saving") this.#set({ status: { kind: "editing" } });
    this.#dirtySince ||= Date.now();
    clearTimeout(this.#idleTimer);
    // 1.5 s after the last keystroke, and at most 8 s after the first unsaved one
    const wait = Math.min(1500, 8000 - (Date.now() - this.#dirtySince));
    this.#idleTimer = setTimeout(() => void this.save(), Math.max(0, wait));
  }

  /** Commit what's unsaved now. One save runs at a time; a call during one runs once more after. */
  save(): Promise<void> {
    clearTimeout(this.#idleTimer);
    if (this.#saving) {
      this.#saveAgain = true;
      return this.#saving;
    }
    this.#saving = this.#saveUntilClean().finally(() => {
      this.#saving = null;
    });
    return this.#saving;
  }

  async #saveUntilClean() {
    let mergedConflicts: number | null = null;
    do {
      this.#saveAgain = false;
      const text = this.#text();
      if (text === this.#base.text) continue;
      this.#dirtySince = 0;
      this.#set({ status: { kind: "saving" } });
      try {
        const merged = await this.options.withRepo((repo) => this.#commit(repo, text));
        if (merged !== null) {
          mergedConflicts = merged;
          this.#saveAgain = true;
        }
      } catch (error) {
        this.#set({
          status: {
            kind: "failed",
            message: error instanceof Error ? error.message : String(error),
          },
        });
        return;
      }
    } while (this.#saveAgain);
    if (this.#text() === this.#base.text)
      this.#set({ status: { kind: "saved", oid: this.#base.oid, mergedConflicts } });
  }

  /** One commit of `text`. Null when it landed; when the repo had moved on, the number of places
   *  the merge kept ours over theirs, after merging the tip into the editor (the caller saves
   *  again). */
  async #commit(repo: Repo, text: string): Promise<number | null> {
    try {
      const result = await repo.commitFiles({
        message: `docs: edit ${this.options.path}`,
        changes: [{ path: this.options.path, content: text }],
        parent: this.#base.oid,
        author: this.options.author,
      });
      this.#base = { oid: result.commitOid || this.#base.oid, text };
      return null;
    } catch (error) {
      // Refused because main moved (someone else committed)? Anything else is a real failure.
      const tip = await repo.tip();
      if (!tip || tip === this.#base.oid) throw error;
      const theirs = (await repo.readFile(this.options.path, { commitOid: tip })) || "";
      const ours = this.#text();
      const merged = mergeText(ours, this.#base.text, theirs);
      // Their edits aren't this person's to undo.
      if (this.#view)
        this.#view.dispatch({
          changes: textChanges(ours, merged.text),
          annotations: Transaction.addToHistory.of(false),
        });
      else this.#detachedText = merged.text;
      this.#base = { oid: tip, text: theirs };
      return merged.conflicts;
    }
  }
}
