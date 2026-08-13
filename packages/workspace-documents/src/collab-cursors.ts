import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import type { CollabConnection } from "./collab-client.ts";
import type { CollabPresence } from "./types.ts";
import { authorColor, authorLabel } from "./collab-author.ts";

/**
 * Live cursors: everyone else's caret as a colored bar wearing a small name
 * flag, plus a tinted span for their selection. Positions arrive in the
 * sender's head coordinates over the session's wait() long-poll; between
 * refreshes the decorations MAP through local and remote edits (the same
 * anchoring trick the redlines use), and every announce self-heals drift.
 *
 * Budgeted for ten concurrent participants: sends are trailing-throttled per
 * client, the server coalesces wakes, and one refresh rebuilds one small
 * RangeSet — no per-keystroke fan-out anywhere.
 */

/** Trailing throttle on announcing the own caret: fast enough to feel live,
 * ~7 messages/second at most while typing. */
const PRESENT_THROTTLE_MS = 150;

class CursorWidget extends WidgetType {
  constructor(readonly clientId: string) {
    super();
  }
  override eq(other: CursorWidget) {
    return other.clientId === this.clientId;
  }
  toDOM() {
    const caret = document.createElement("span");
    caret.className = "cm-remote-caret";
    caret.style.borderLeftColor = authorColor(this.clientId, 1);
    const flag = document.createElement("span");
    flag.className = "cm-remote-caret-flag";
    flag.style.backgroundColor = authorColor(this.clientId, 1);
    flag.textContent = authorLabel(this.clientId);
    caret.appendChild(flag);
    return caret;
  }
  override ignoreEvent() {
    return true;
  }
}

function cursorDecorations(
  clients: CollabPresence["clients"],
  ownClientId: string,
  docLength: number,
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const remote: (CollabPresence["clients"][number] & { from: number; to: number })[] = [];
  for (const client of clients) {
    if (client.clientId === ownClientId) continue;
    remote.push({
      ...client,
      from: Math.min(Math.min(client.anchor, client.head), docLength),
      to: Math.min(Math.max(client.anchor, client.head), docLength),
    });
  }
  remote.sort(
    (left, right) => left.from - right.from || left.clientId.localeCompare(right.clientId),
  );
  for (const client of remote) {
    if (client.from < client.to) {
      builder.add(
        client.from,
        client.to,
        Decoration.mark({
          attributes: { style: `background: ${authorColor(client.clientId, 0.22)}` },
          class: "cm-remote-selection",
        }),
      );
    }
    const head = Math.min(client.head, docLength);
    builder.add(
      head,
      head,
      Decoration.widget({ side: 1, widget: new CursorWidget(client.clientId) }),
    );
  }
  return builder.finish();
}

export function remoteCursorsExtension(connection: CollabConnection) {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet = Decoration.none;
      timer: ReturnType<typeof setTimeout> | null = null;
      lastSent: { anchor: number; head: number } | null = null;
      /** Re-announce every 25s: a lost join send self-heals, and an idle
       * open sheet stays fresh past the server's 45s staleness window. */
      heartbeat = setInterval(() => {
        this.lastSent = null;
        this.send();
      }, 25_000);

      constructor(readonly view: EditorView) {
        connection.onPresence = (clients) => {
          this.decorations = cursorDecorations(
            clients,
            connection.clientId,
            this.view.state.doc.length,
          );
          // Nudge a measure/paint without touching the doc.
          this.view.dispatch({});
        };
        // Join announce: peers see this caret before the first local move.
        this.send();
      }

      update(update: ViewUpdate) {
        // Keep remote carets anchored to the text they sit in while edits
        // fly; the senders' next announces correct any residual drift.
        if (update.docChanged) this.decorations = this.decorations.map(update.changes);
        if (update.selectionSet || update.docChanged) this.schedule();
      }

      schedule() {
        if (Number.isFinite(this.timer)) return;
        this.timer = setTimeout(() => {
          this.timer = null;
          this.send();
        }, PRESENT_THROTTLE_MS);
      }

      send() {
        const { anchor, head } = this.view.state.selection.main;
        if (this.lastSent?.anchor === anchor && this.lastSent.head === head) return;
        this.lastSent = { anchor, head };
        connection.present({ anchor, head });
      }

      destroy() {
        connection.onPresence = null;
        clearInterval(this.heartbeat);
        if (Number.isFinite(this.timer)) clearTimeout(this.timer);
        // Leave quietly so peers drop this caret instead of aging it out.
        connection.present(null);
      }
    },
    { decorations: (value) => value.decorations },
  );
  return [plugin, theme];
}

const theme = EditorView.baseTheme({
  ".cm-remote-caret": {
    borderLeft: "2px solid",
    display: "inline-block",
    height: "1.15em",
    marginLeft: "-1px",
    position: "relative",
    verticalAlign: "text-bottom",
  },
  ".cm-remote-caret-flag": {
    borderRadius: "3px 3px 3px 0",
    color: "#fff",
    fontFamily: "var(--font-sans, system-ui)",
    fontSize: "9px",
    left: "-2px",
    lineHeight: "1.3",
    padding: "0 3px",
    position: "absolute",
    top: "-1.2em",
    userSelect: "none",
    whiteSpace: "nowrap",
    zIndex: "60",
  },
  ".cm-remote-selection": { borderRadius: "2px" },
});
