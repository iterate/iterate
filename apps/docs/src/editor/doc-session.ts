// One open doc: its editor, co-edited through the doc's processor (@iterate-com/docs). The page
// reads `state()` through useSyncExternalStore; everything that changes it happens here.
//
// The editor opens read-only on the text the page loaded, and goes live once the tab has synced
// with the doc's processor (collab.ts): from then on the editor is bound to the shared Y.Text
// (y-codemirror.next), and the processor saves. Its live state (`commitOid`, `dirty`, `savedBy`,
// `saveError`) is what the status line says.
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import * as Y from "yjs";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import { z } from "zod";
import type { IterateContextApi } from "iterate/api";
import { connectLiveState } from "iterate/client";
import { DocLiveState } from "@iterate-com/docs/frames";
import { DocCollab, type CollabStatus } from "./collab.ts";
import { docEditorExtensions, previewExtensions, type EditorMode } from "./extensions.ts";

export type DocStatus =
  | { kind: "opening" }
  | { kind: "editing" }
  | { kind: "saved"; oid: string; by: string[] }
  | { kind: "save-failed"; message: string }
  | { kind: "disconnected"; message: string };

export type DocSessionState = {
  mode: EditorMode;
  status: DocStatus;
  /** Everyone else with the doc open, by name. */
  others: string[];
};

type DocSessionOptions = {
  path: string;
  /** The doc as the page loaded it: what the editor shows until it's live. */
  text: string;
  /** Who's typing, as the others see them. */
  user: { name: string };
  /** Open the doc's context, set up for co-editing (`ensureDoc`); `dispose` lets it go. */
  open: () => Promise<{ context: IterateContextApi; dispose: () => void }>;
};

const Seed = z.object({ rev: z.number(), state: DocLiveState });

/** One mount of the editor: whether it's gone, and what to let go when it goes. */
type Attachment = { unmounted: boolean; cleanups: (() => void)[] };

export class DocSession {
  #state: DocSessionState = { mode: "rich", status: { kind: "opening" }, others: [] };
  #listeners = new Set<() => void>();
  #preview = new Compartment();
  #view: EditorView | null = null;
  #collab: DocCollab | null = null;
  #undo: Y.UndoManager | null = null;
  #collabStatus: CollabStatus = { kind: "opening" };
  #live: DocLiveState | undefined;

  options: DocSessionOptions;

  constructor(options: DocSessionOptions) {
    this.options = options;
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
   *  mounted. Closing the tab before this tab's edits have been sent asks first. */
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
    const attachment: Attachment = { unmounted: false, cleanups: [] };
    const warnIfUnsent = (event: BeforeUnloadEvent) => {
      if (this.#collab?.unsent()) event.preventDefault();
    };
    window.addEventListener("beforeunload", warnIfUnsent);
    void this.#goLive(view, attachment);
    return () => {
      attachment.unmounted = true;
      window.removeEventListener("beforeunload", warnIfUnsent);
      for (const cleanup of attachment.cleanups.reverse()) cleanup();
      this.#view = null;
      this.#collab = null;
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
      this.#hold(attachment, opened.dispose);
      if (attachment.unmounted) return;
      const collab = new DocCollab({
        context: opened.context,
        user: { name: this.options.user.name, color: colorOf(this.options.user.name) },
        onStatus: (status) => {
          this.#collabStatus = status;
          this.#refresh();
        },
      });
      this.#hold(attachment, () => collab.dispose());
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
          this.#live = next;
          this.#refresh();
        }),
      );
      this.#live = live.store.get();
      this.#collab = collab;
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
      docEditorExtensions({ mode: this.#state.mode, preview: this.#preview }),
      // the text box is named by the file it edits
      EditorView.contentAttributes.of({ "aria-label": this.options.path }),
    ];
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
    const others = this.#collab
      ? [...this.#collab.awareness.getStates()]
          .filter(([client]) => client !== this.#collab!.doc.clientID)
          .map(([, state]) => (state as { user?: { name?: string } }).user?.name)
          .filter((name): name is string => Boolean(name))
      : [];
    this.#set({ status, others });
  }

  /** Sync with the doc's processor again: what "Try again" does after the connection failed. */
  reconnect() {
    void this.#collab?.sync();
  }

  setMode(mode: EditorMode) {
    this.#view?.dispatch({ effects: this.#preview.reconfigure(previewExtensions(mode)) });
    this.#set({ mode });
    this.#view?.focus();
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
