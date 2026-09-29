// One open doc: its editor, co-edited through the doc's processor (@iterate-com/docs). The page
// reads `state()` through useSyncExternalStore; everything that changes it happens here.
//
// A markdown file gets the live-preview editor (Rich / Markdown); any other text file a code editor
// in its language, and an html file a Preview beside it, the live text in a sandboxed frame.
//
// The editor opens read-only on the text the page loaded, and goes live once the tab has synced
// with the doc's processor (collab.ts): from then on the editor is bound to the shared Y.Text
// (y-codemirror.next), and the processor saves. Its live state (`commitOid`, `dirty`, `savedBy`,
// `saveError`) is what the status line says.
//
// COMMENTS are events this tab appends to the doc's context (@iterate-com/docs/comments); the
// threads come back in the processor's live state, and the editor highlights each one's text
// (comment-marks.ts). A comment being written is a draft here until its thread comes back.
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import * as Y from "yjs";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import { z } from "zod";
import type { IterateContextApi } from "iterate/api";
import { connectLiveState } from "iterate/client";
import { quoteAt, type Quote } from "@iterate-com/docs/anchor";
import {
  COMMENT_ADDED,
  COMMENT_DELETED,
  COMMENT_EDITED,
  COMMENT_REOPENED,
  COMMENT_REPLIED,
  COMMENT_RESOLVED,
  type CommentThread,
} from "@iterate-com/docs/comments";
import { DocLiveState } from "@iterate-com/docs/frames";
import type { FileKind } from "../lib/file-kind.ts";
import { DocCollab, type CollabStatus } from "./collab.ts";
import { commentMarks, commentTheme, setMarked } from "./comment-marks.ts";
import {
  codeEditorExtensions,
  codeLanguage,
  docEditorExtensions,
  previewExtensions,
  type EditorMode,
} from "./extensions.ts";

/** What the page shows of the file: a markdown file's Rich or Markdown, an html file's Preview or
 *  Source, and the code editor for anything else. */
export type DocMode = EditorMode | "preview" | "source" | "code";

export type DocStatus =
  | { kind: "opening" }
  | { kind: "editing" }
  | { kind: "saved"; oid: string; by: string[] }
  | { kind: "save-failed"; message: string }
  | { kind: "disconnected"; message: string };

/** A thread as the panel lists it: `attached` false when its quote is found nowhere in the text. */
export type ThreadView = CommentThread & { attached: boolean };

/** A comment being written: the thread it'll start (its id made here), and its quote, or none for a
 *  comment on the whole doc. */
export type Draft = { thread: string; quote: Quote | null };

export type DocSessionState = {
  mode: DocMode;
  status: DocStatus;
  /** Everyone else with the doc open, by name. */
  others: string[];
  /** An html file's text for its Preview, at most twice a second behind the editor's. */
  previewText: string;
  /** The doc's comment threads: those on the whole doc, then the rest in the order their text
   *  comes, then those found nowhere, in the order they were started. */
  threads: ThreadView[];
  /** The selected thread: clicked in the panel, or the one the cursor is in. */
  active: string | null;
  draft: Draft | null;
  /** The comment of this person's being edited. */
  editing: { thread: string; comment: string } | null;
};

type DocSessionOptions = {
  path: string;
  /** What it opens as (lib/file-kind.ts); a binary file doesn't open. */
  kind: Exclude<FileKind, "binary">;
  /** The doc as the page loaded it: what the editor shows until it's live. */
  text: string;
  /** Who's typing, as the others see them. */
  user: { name: string };
  /** Open the doc's context, set up for co-editing (`ensureDoc`); `dispose` lets it go. */
  open: () => Promise<{ context: IterateContextApi; dispose: () => void }>;
};

const Seed = z.object({ rev: z.number(), state: DocLiveState });

/** A tab's awareness state as collab.ts sets it: whose tab it is. */
const AwarenessUser = z.object({ user: z.object({ name: z.string().min(1) }) });

/** One mount of the editor: whether it's gone, and what to let go when it goes. */
type Attachment = { unmounted: boolean; cleanups: (() => void)[] };

/** The first view of each kind of file. */
const firstMode: Record<DocSessionOptions["kind"], DocMode> = {
  markdown: "rich",
  html: "preview",
  code: "code",
};

export class DocSession {
  #state: DocSessionState;
  #listeners = new Set<() => void>();
  #preview = new Compartment();
  /** A code file's language, once its grammar has loaded. */
  #language = new Compartment();
  #languageSupport: Extension = [];
  #previewTimer: ReturnType<typeof setTimeout> | undefined;
  #view: EditorView | null = null;
  #collab: DocCollab | null = null;
  #undo: Y.UndoManager | null = null;
  #collabStatus: CollabStatus = { kind: "opening" };
  #live: DocLiveState | undefined;
  #context: IterateContextApi | null = null;
  /** The threads as last listed, and their order and attachment: the panel changes with these. */
  #listed: CommentThread[] = [];
  #threadsKey = "";

  options: DocSessionOptions;

  constructor(options: DocSessionOptions) {
    this.options = options;
    this.#state = {
      mode: firstMode[options.kind],
      status: { kind: "opening" },
      others: [],
      previewText: options.text,
      threads: [],
      active: null,
      draft: null,
      editing: null,
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

  /** The editor's element, as a React ref: the view and the doc's connection live while it's
   *  mounted. Closing the tab before this tab's edits have been sent asks first; closing it tells
   *  the doc's processor this tab has left, as unmounting does. */
  mount = (parent: HTMLDivElement | null) => {
    if (!parent) return;
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: this.options.text,
        extensions: [
          this.#extensions(),
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
        ],
      }),
    });
    this.#view = view;
    if (this.options.kind !== "markdown") void this.#loadLanguage();
    const attachment: Attachment = { unmounted: false, cleanups: [] };
    const warnIfUnsent = (event: BeforeUnloadEvent) => {
      if (this.#collab?.unsent()) event.preventDefault();
    };
    window.addEventListener("beforeunload", warnIfUnsent);
    // a closing tab never unmounts: say goodbye now, if the socket lasts long enough to carry it
    const leave = () => void this.#collab?.close();
    window.addEventListener("pagehide", leave);
    void this.#goLive(view, attachment);
    return () => {
      attachment.unmounted = true;
      window.removeEventListener("beforeunload", warnIfUnsent);
      window.removeEventListener("pagehide", leave);
      for (const cleanup of attachment.cleanups.reverse()) cleanup();
      clearTimeout(this.#previewTimer);
      this.#previewTimer = undefined;
      this.#view = null;
      this.#collab = null;
      this.#context = null;
      this.#undo = null;
      view.destroy();
    };
  };

  /** Let `cleanup` go with the view: at once when the view has gone already. */
  #hold(attachment: Attachment, cleanup: () => void) {
    if (attachment.unmounted) cleanup();
    else attachment.cleanups.push(cleanup);
  }

  async #goLive(view: EditorView, attachment: Attachment) {
    try {
      const opened = await this.options.open();
      // the context goes once the tab has left the doc (collab.close), which sends on it
      let closing: Promise<unknown> = Promise.resolve();
      this.#hold(attachment, () => void closing.finally(opened.dispose));
      if (attachment.unmounted) return;
      const collab = new DocCollab({
        context: opened.context,
        user: { name: this.options.user.name, color: colorOf(this.options.user.name) },
        onStatus: (status) => {
          this.#collabStatus = status;
          this.#refresh();
        },
      });
      this.#hold(attachment, () => {
        closing = collab.close();
      });
      collab.awareness.on("change", () => this.#refresh());
      await collab.open();
      if (attachment.unmounted) return;
      const live = await connectLiveState<DocLiveState>(opened.context, {
        key: "doc",
        readSeed: async () =>
          Seed.parse(await opened.context.invoke("itx.facets.get('doc').liveSnapshot()")),
      });
      this.#hold(attachment, () => void live.dispose());
      if (attachment.unmounted) return;
      this.#hold(
        attachment,
        live.store.subscribe(() => {
          const next = live.store.get();
          // a save landed: sync again, in case a frame either way went missing before it
          if (next?.commitOid !== this.#live?.commitOid) void collab.sync();
          const threadsChanged = next?.threads !== this.#live?.threads;
          this.#live = next;
          this.#refresh();
          if (threadsChanged) this.#threadsChanged();
        }),
      );
      this.#live = live.store.get();
      this.#collab = collab;
      this.#context = opened.context;
      this.#undo = new Y.UndoManager(collab.text);
      view.setState(
        EditorState.create({
          doc: collab.text.toString(),
          extensions: [
            this.#extensions(),
            yCollab(collab.text, collab.awareness, { undoManager: this.#undo }),
            keymap.of(yUndoManagerKeymap),
          ],
        }),
      );
      this.#refresh();
      this.#threadsChanged();
    } catch (error) {
      this.#collabStatus = {
        kind: "failed",
        message: error instanceof Error ? error.message : String(error),
      };
      this.#refresh();
    }
  }

  #extensions(): Extension {
    return [
      this.options.kind === "markdown"
        ? docEditorExtensions({
            mode: this.#state.mode === "markdown" ? "markdown" : "rich",
            preview: this.#preview,
          })
        : codeEditorExtensions({ language: this.#language.of(this.#languageSupport) }),
      // the text box is named by the file it edits
      EditorView.contentAttributes.of({ "aria-label": this.options.path }),
      commentMarks,
      commentTheme,
      // Google Docs' shortcut for a comment on the selection
      keymap.of([{ key: "Mod-Alt-m", run: () => this.startComment(), preventDefault: true }]),
      EditorView.updateListener.of((update) => {
        if (update.startState.field(commentMarks) !== update.state.field(commentMarks))
          this.#listThreads();
      }),
      this.options.kind === "html"
        ? EditorView.updateListener.of((update) => {
            if (update.docChanged) this.#schedulePreview();
          })
        : [],
    ];
  }

  /** The file's grammar, fetched once, into whichever state the view has by then. */
  async #loadLanguage() {
    this.#languageSupport = await codeLanguage(this.options.path);
    this.#view?.dispatch({ effects: this.#language.reconfigure(this.#languageSupport) });
  }

  #schedulePreview() {
    if (this.#previewTimer) return;
    this.#previewTimer = setTimeout(() => {
      this.#previewTimer = undefined;
      if (this.#view) this.#set({ previewText: this.#view.state.doc.toString() });
    }, 500);
  }

  #refresh() {
    const live = this.#live;
    const status: DocStatus =
      this.#collabStatus.kind === "failed"
        ? { kind: "disconnected", message: this.#collabStatus.message }
        : !this.#collab || !live
          ? { kind: "opening" }
          : live.saveError
            ? { kind: "save-failed", message: live.saveError }
            : live.dirty || !live.commitOid
              ? { kind: "editing" }
              : { kind: "saved", oid: live.commitOid, by: live.savedBy };
    const collab = this.#collab;
    const others = collab
      ? [...collab.awareness.getStates()]
          .filter(([client]) => client !== collab.doc.clientID)
          .flatMap(([, state]) => {
            const parsed = AwarenessUser.safeParse(state);
            return parsed.success ? [parsed.data.user.name] : [];
          })
      : [];
    this.#set({ status, others });
  }

  /** The live state's threads changed: a draft whose thread has come back is done, and the
   *  editor highlights the open threads' text. */
  #threadsChanged() {
    const threads = this.#live ? this.#live.threads : [];
    const draft = this.#state.draft;
    if (draft && threads.some((thread) => thread.id === draft.thread)) this.#set({ draft: null });
    this.#mark(this.#state.active);
    this.#listThreads();
  }

  /** Tell the editor what to highlight, and which thread is selected. */
  #mark(active: string | null) {
    const open = (this.#live ? this.#live.threads : []).filter((thread) => !thread.resolved);
    const draft = this.#state.draft;
    const quoted = [...open, ...(draft ? [{ id: draft.thread, quote: draft.quote }] : [])].flatMap(
      (thread) => (thread.quote ? [{ id: thread.id, quote: thread.quote }] : []),
    );
    this.#view?.dispatch({ effects: setMarked.of({ threads: quoted, active }) });
  }

  /** The threads in the panel's order, when that order, what's attached or what's selected moved. */
  #listThreads() {
    const marks = this.#view?.state.field(commentMarks, false);
    const ranges = marks ? marks.ranges : new Map<string, { from: number }>();
    const active = marks ? marks.active : this.#state.active;
    const threads = this.#live ? this.#live.threads : [];
    // the whole doc's first, then by where their text is; found nowhere, last
    const at = (thread: CommentThread) => {
      const range = ranges.get(thread.id);
      return !thread.quote ? -1 : range ? range.from : Number.POSITIVE_INFINITY;
    };
    const views = [...threads]
      .sort((a, b) => at(a) - at(b))
      .map((thread) => ({ ...thread, attached: at(thread) !== Number.POSITIVE_INFINITY }));
    const key = views.map((view) => `${view.id}${view.attached ? "" : "!"}`).join(" ");
    if (key === this.#threadsKey && threads === this.#listed && active === this.#state.active)
      return;
    this.#threadsKey = key;
    this.#listed = threads;
    this.#set({ threads: views, active });
  }

  /** Start a comment on the selection, or on the whole doc when nothing is selected. */
  startComment() {
    const view = this.#view;
    if (!view || !this.#context) return false;
    const text = view.state.doc.toString();
    let { from, to } = view.state.selection.main;
    // a selection's spaces and line breaks at either end aren't what it's about
    while (from < to && /\s/.test(text[from]!)) from++;
    while (to > from && /\s/.test(text[to - 1]!)) to--;
    const thread = crypto.randomUUID();
    this.#set({
      draft: { thread, quote: to > from ? quoteAt(text, from, to) : null },
      active: thread,
    });
    this.#mark(thread);
    return true;
  }

  cancelDraft() {
    this.#set({ draft: null, active: null });
    this.#mark(null);
  }

  /** Post the draft; it stays a draft until its thread comes back in the live state. */
  async postDraft(body: string) {
    const draft = this.#state.draft;
    if (!draft) return;
    await this.#append(COMMENT_ADDED, { thread: draft.thread, quote: draft.quote, body });
  }

  reply(thread: string, body: string) {
    return this.#append(COMMENT_REPLIED, { thread, comment: crypto.randomUUID(), body });
  }

  startEditing(thread: string, comment: string) {
    this.#set({ editing: { thread, comment } });
  }

  stopEditing() {
    this.#set({ editing: null });
  }

  async editComment(thread: string, comment: string, body: string) {
    await this.#append(COMMENT_EDITED, { thread, comment, body });
    this.stopEditing();
  }

  deleteComment(thread: string, comment: string) {
    return this.#append(COMMENT_DELETED, { thread, comment });
  }

  resolve(thread: string) {
    return this.#append(COMMENT_RESOLVED, { thread });
  }

  reopen(thread: string) {
    return this.#append(COMMENT_REOPENED, { thread });
  }

  /** Select a thread from the panel: its text highlighted and scrolled to, in the editor. */
  focusThread(thread: string) {
    this.#set({ active: thread });
    this.#mark(thread);
    const range = this.#view?.state.field(commentMarks, false)?.ranges.get(thread);
    if (!range) return;
    // an html file's Preview has no text to point at
    if (this.#state.mode === "preview") this.setMode("source");
    this.#view?.dispatch({ effects: EditorView.scrollIntoView(range.from, { y: "center" }) });
  }

  async #append(type: string, payload: Record<string, unknown>) {
    if (!this.#context) throw new Error("The doc isn't open yet");
    await this.#context.append({ type, payload });
  }

  /** Sync with the doc's processor again: what "Try again" does after the connection failed. */
  reconnect() {
    void this.#collab?.sync();
  }

  setMode(mode: DocMode) {
    if (mode === "rich" || mode === "markdown")
      this.#view?.dispatch({ effects: this.#preview.reconfigure(previewExtensions(mode)) });
    this.#set({ mode });
    if (mode !== "preview") this.#view?.focus();
  }

  /** Run a formatting command (commands.ts) on the editor. */
  run(command: (view: EditorView) => boolean) {
    if (this.#view) command(this.#view);
  }

  /** Undo this person's last edit; the others' stay. */
  undo() {
    this.#undo?.undo();
  }

  redo() {
    this.#undo?.redo();
  }
}

/** A cursor colour per person, the same in every tab. */
function colorOf(name: string) {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  const colors = [
    "#e5484d",
    "#f76b15",
    "#ffc53d",
    "#30a46c",
    "#12a594",
    "#0090ff",
    "#8e4ec6",
    "#d6409f",
  ];
  return colors[Math.abs(hash) % colors.length]!;
}
