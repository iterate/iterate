import { useEffect, useRef } from "react";
import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import { EditorState, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  hoverTooltip,
  keymap,
  WidgetType,
  type DecorationSet,
} from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import { agoText, transactionAuthor, type RecentSpan } from "../lib/recency.ts";

const editorTheme = EditorView.theme(
  {
    "&": {
      backgroundColor: "transparent",
      color: "var(--foreground)",
      fontSize: "0.85rem",
      height: "100%",
    },
    "&.cm-focused": { outline: "none" },
    ".cm-content": {
      fontFamily: "ui-monospace, monospace",
      caretColor: "var(--foreground)",
      padding: "0.6rem 0.25rem",
    },
    ".cm-scroller": { fontFamily: "ui-monospace, monospace" },
    ".cm-ySelectionInfo": {
      fontFamily: "system-ui, sans-serif",
      fontSize: "0.65rem",
      padding: "0.05rem 0.3rem",
      borderRadius: "4px",
      opacity: 1,
    },
    ".cm-tooltip": {
      backgroundColor: "var(--popover)",
      color: "var(--popover-foreground)",
      border: "1px solid var(--border)",
      borderRadius: "6px",
      padding: "0.2rem 0.5rem",
      fontSize: "0.7rem",
      fontFamily: "system-ui, sans-serif",
    },
  },
  { dark: false },
);

// ---------------------------------------------------------------------------
// Recency glow: remote insertions get a mark decoration in their author's
// color for RECENT_TOUCH_TTL_MS. Yjs hands us exactly which items each
// remote transaction added (and their author's clientID); CodeMirror's
// decoration mapping keeps the marks glued to the right characters while
// everyone keeps typing. Hovering a glow names the author.
// ---------------------------------------------------------------------------

type GlowMeta = { id: number; name: string; at: number; deleted: boolean };
type GlowSpec = { color: string; meta: GlowMeta } & (
  | { kind: "insert"; from: number; to: number }
  | { kind: "delete"; pos: number; text: string }
);

const addGlow = StateEffect.define<GlowSpec>();
const clearGlow = StateEffect.define<number>();

/** Inline ghost of just-deleted text, the y-prosemirror "ychange" idea. */
class DeletedTextWidget extends WidgetType {
  constructor(
    private readonly text: string,
    private readonly color: string,
  ) {
    super();
  }
  override eq(other: DeletedTextWidget): boolean {
    return other.text === this.text && other.color === this.color;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.textContent = this.text;
    span.style.cssText = `background-color:${this.color}1f;color:${this.color};text-decoration:line-through;opacity:0.85;`;
    return span;
  }
}

const glowField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, transaction) {
    let next = decorations.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(addGlow)) {
        const value = effect.value;
        if (value.kind === "insert" && value.to > value.from) {
          next = next.update({
            add: [
              Decoration.mark({
                attributes: {
                  // No border-radius: adjacent per-keystroke marks must read
                  // as ONE straight underline, not a scalloped row of pills.
                  style: `background-color: ${value.color}2e; border-bottom: 1.5px solid ${value.color};`,
                },
                glowMeta: value.meta,
              }).range(value.from, value.to),
            ],
          });
        } else if (value.kind === "delete" && value.text !== "") {
          next = next.update({
            add: [
              Decoration.widget({
                widget: new DeletedTextWidget(value.text, value.color),
                side: 1,
                glowMeta: value.meta,
              }).range(value.pos),
            ],
          });
        }
      } else if (effect.is(clearGlow)) {
        next = next.update({
          filter: (_from, _to, value) =>
            (value.spec as { glowMeta?: GlowMeta }).glowMeta?.id !== effect.value,
        });
      }
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const glowHover = hoverTooltip((view, pos) => {
  let found: { from: number; to: number; meta: GlowMeta } | null = null;
  view.state.field(glowField).between(pos, pos, (from, to, value) => {
    const meta = (value.spec as { glowMeta?: GlowMeta }).glowMeta;
    if (meta !== undefined) {
      found = { from, to, meta };
      return false;
    }
  });
  const hit = found as { from: number; to: number; meta: GlowMeta } | null;
  if (hit === null) return null;
  return {
    pos: hit.from,
    end: hit.to,
    above: true,
    create: () => {
      const dom = document.createElement("div");
      dom.textContent = `${hit.meta.name} · ${hit.meta.deleted ? "deleted" : "added"} · ${agoText(hit.meta.at)}`;
      return { dom };
    },
  };
});

/**
 * The collaborative markdown editor for one task file: CodeMirror 6 bound to
 * the checkout's Y.Text via yCollab, so remote collaborators' cursors and
 * selection highlights render live (colored by their awareness `user`), and
 * fresh remote insertions glow in their author's color. While mounted, it
 * advertises the open file on awareness `openPath` — the board uses that for
 * its card presence dots.
 */
export function TaskEditor({
  path,
  text,
  awareness,
  focusHeadline,
  initialSpans,
  onSubmit,
}: {
  path: string;
  text: Y.Text;
  awareness: Awareness;
  /** Place the caret on the first `# heading` after mount: "select" covers
   * the heading text (typing replaces it), "end" parks after it. */
  focusHeadline?: "select" | "end";
  /** Uncommitted attribution recorded before this mount — re-painted so
   * closing and reopening the sheet keeps who-wrote-what visible. */
  initialSpans?: RecentSpan[];
  /** ⌘↩ — "I'm done here" (the sheet closes itself). */
  onSubmit?: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;
  const initialSpansRef = useRef(initialSpans);
  initialSpansRef.current = initialSpans;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const undoManager = new Y.UndoManager(text);
    const view = new EditorView({
      state: EditorState.create({
        doc: text.toString(),
        extensions: [
          keymap.of([
            {
              key: "Mod-Enter",
              run: () => {
                onSubmitRef.current?.();
                return true;
              },
            },
            ...yUndoManagerKeymap,
            ...defaultKeymap,
          ]),
          EditorView.lineWrapping,
          editorTheme,
          yCollab(text, awareness, { undoManager }),
          glowField,
          glowHover,
        ],
      }),
      parent: container,
    });

    if (focusHeadline !== undefined) {
      const content = view.state.doc.toString();
      const heading = /^#\s+(.*)$/m.exec(content);
      if (heading !== null) {
        const end = heading.index + heading[0].length;
        const start = end - (heading[1]?.length ?? 0);
        view.dispatch({
          selection: focusHeadline === "select" ? { anchor: start, head: end } : { anchor: end },
          scrollIntoView: true,
        });
      }
      view.focus();
    } else {
      // Opening an existing task: ready to type, caret at the end.
      view.dispatch({ selection: { anchor: view.state.doc.length }, scrollIntoView: true });
      view.focus();
    }

    // Re-paint the attribution recorded before this mount, so open/close
    // cycles keep who-wrote-what visible until commit clears it.
    let glowId = 0;
    {
      const seeds = (initialSpansRef.current ?? []).filter(
        (span) => span.to > span.from && span.from < view.state.doc.length,
      );
      if (seeds.length > 0) {
        view.dispatch({
          effects: seeds.map((span) =>
            addGlow.of({
              kind: "insert",
              from: span.from,
              to: Math.min(span.to, view.state.doc.length),
              color: span.author.color,
              meta: { id: ++glowId, name: span.author.name, at: span.at, deleted: false },
            }),
          ),
        });
      }
    }

    // yCollab's own Y observer registered first (at view creation), so by
    // the time this observer runs the CM doc already reflects the event and
    // the delta's indices are valid CM positions.
    const observer = (event: Y.YTextEvent, transaction: Y.Transaction) => {
      const doc = text.doc;
      if (doc === null) return;
      const author = transactionAuthor(doc, transaction);
      if (author === null) return;

      // Deleted content, recovered from the transaction's tombstones in
      // creation order and consumed per delete-run below.
      let deletedPool = [...event.changes.deleted]
        .sort((a, b) => a.id.client - b.id.client || a.id.clock - b.id.clock)
        .map((item) =>
          (item.content.getContent() as unknown[])
            .filter((part): part is string => typeof part === "string")
            .join(""),
        )
        .join("");

      const effects: Array<StateEffect<GlowSpec | number>> = [];
      let index = 0;
      for (const op of event.delta) {
        if (typeof op.retain === "number") index += op.retain;
        else if (typeof op.insert === "string") {
          const id = ++glowId;
          effects.push(
            addGlow.of({
              kind: "insert",
              from: index,
              to: index + op.insert.length,
              color: author.color,
              meta: { id, name: author.name, at: Date.now(), deleted: false },
            }),
          );
          index += op.insert.length;
        } else if (typeof op.delete === "number") {
          const deletedText = deletedPool.slice(0, op.delete);
          deletedPool = deletedPool.slice(op.delete);
          const id = ++glowId;
          effects.push(
            addGlow.of({
              kind: "delete",
              pos: index,
              text: deletedText,
              color: author.color,
              meta: { id, name: author.name, at: Date.now(), deleted: true },
            }),
          );
        }
      }
      // Deferred: for LOCAL typing this observer fires inside CodeMirror's
      // own dispatch cycle, where a nested dispatch would throw.
      if (effects.length > 0) queueMicrotask(() => view.dispatch({ effects }));
    };
    text.observe(observer);

    return () => {
      text.unobserve(observer);
      view.destroy();
      undoManager.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- focusHeadline is a mount-time hint only; refocusing on every prop wobble would fight the user's caret
  }, [text, awareness]);

  useEffect(() => {
    awareness.setLocalStateField("openPath", path);
    return () => {
      awareness.setLocalStateField("openPath", null);
    };
  }, [path, awareness]);

  return <div ref={containerRef} style={{ flex: 1, minHeight: "16rem", overflow: "hidden" }} />;
}
