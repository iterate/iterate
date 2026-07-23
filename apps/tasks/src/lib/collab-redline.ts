import {
  EditorView,
  Decoration,
  ViewPlugin,
  WidgetType,
  hoverTooltip,
  type DecorationSet,
  type Tooltip,
  type ViewUpdate,
} from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { getSyncedVersion, sendableUpdates } from "@codemirror/collab";
import type { CollabConnection } from "./collab-client.ts";
import type { CollabChangeSegment } from "./tasks-api.ts";

/**
 * The redline layer: WHERE somebody added text (author-tinted highlight),
 * a ⌫ marker WHERE something was deleted, and a hover tooltip saying WHO
 * and WHEN (plus the deleted text on markers). Fed by the server's op-log
 * fold; no accept/reject machinery — the document is the document.
 */

/** Stable, legible per-author hue (agents get the platform violet). */
function authorColor(clientId: string, alpha = 0.35): string {
  if (clientId === "external") return `hsla(262, 83%, 58%, ${alpha})`;
  let hash = 0;
  for (const char of clientId) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return `hsla(${((hash % 360) + 360) % 360}, 70%, 45%, ${alpha})`;
}

/** Human name for a change author: agents are "agent"; browser clients embed
 * a display slug in their id (`u-<slug>-<rand>`); anything else is someone. */
export function authorLabel(clientId: string): string {
  if (clientId === "external") return "agent";
  const named = /^u-(.+)-[a-z0-9]+$/.exec(clientId);
  if (named) return named[1]!.replaceAll("-", " ");
  return "someone";
}

function whenLabel(createdAt: number | undefined): string {
  if (!createdAt) return "";
  const delta = Date.now() - createdAt;
  if (delta < 60_000) return "just now";
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  return new Date(createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function tooltipCard(author: string, when: string, deleted?: string): HTMLElement {
  const card = document.createElement("div");
  card.className = "cm-redline-tooltip";
  const line = document.createElement("div");
  line.textContent =
    deleted !== undefined
      ? `${author} deleted${when ? ` · ${when}` : ""}`
      : `${author} added${when ? ` · ${when}` : ""}`;
  card.appendChild(line);
  if (deleted) {
    const snippet = document.createElement("div");
    snippet.className = "cm-redline-tooltip-snippet";
    snippet.textContent = deleted;
    card.appendChild(snippet);
  }
  return card;
}

class DeletionFlag extends WidgetType {
  constructor(
    readonly clientId: string,
    readonly text: string,
    readonly createdAt: number | undefined,
  ) {
    super();
  }
  override eq(other: DeletionFlag) {
    return (
      other.clientId === this.clientId &&
      other.text === this.text &&
      other.createdAt === this.createdAt
    );
  }
  toDOM() {
    const flag = document.createElement("span");
    flag.className = "cm-redline-del";
    flag.dataset.author = this.clientId;
    flag.dataset.when = String(this.createdAt ?? "");
    flag.dataset.deleted = this.text.slice(0, 200);
    flag.style.color = authorColor(this.clientId, 1);
    flag.textContent = "⌫";
    // A zero-width widget has no text position for hoverTooltip to map to —
    // the flag carries its own hover card, styled identically.
    let card: HTMLElement | null = null;
    flag.addEventListener("mouseenter", () => {
      card = tooltipCard(
        authorLabel(this.clientId),
        whenLabel(this.createdAt),
        this.text.slice(0, 200),
      );
      card.classList.add("cm-redline-tooltip-floating");
      const at = flag.getBoundingClientRect();
      card.style.left = `${at.left}px`;
      card.style.top = `${at.top}px`;
      // Inside the editor root so the baseTheme's scoped styles apply
      // (position: fixed keeps it viewport-anchored regardless of parent).
      (flag.closest(".cm-editor") ?? document.body).appendChild(card);
    });
    flag.addEventListener("mouseleave", () => {
      card?.remove();
      card = null;
    });
    return flag;
  }
  override destroy(flag: HTMLElement) {
    flag.dispatchEvent(new Event("mouseleave"));
  }
}

function decorate(segments: CollabChangeSegment[], docLength: number): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  // RangeSetBuilder demands ascending positions; the server sorts, but
  // clamping (and any future source) must not be able to crash the layer —
  // sort defensively, deletions before insertions at a tie.
  const ordered = [...segments].sort((left, right) => {
    const position = (segment: CollabChangeSegment) =>
      segment.kind === "inserted"
        ? Math.min(segment.from, docLength)
        : Math.min(segment.at, docLength);
    return (
      position(left) - position(right) ||
      (left.kind === "deleted" ? -1 : 0) - (right.kind === "deleted" ? -1 : 0)
    );
  });
  for (const segment of ordered) {
    if (segment.kind === "deleted") {
      const at = Math.min(segment.at, docLength);
      builder.add(
        at,
        at,
        Decoration.widget({
          side: -1,
          widget: new DeletionFlag(segment.clientId, segment.text, segment.createdAt),
        }),
      );
    } else {
      const from = Math.min(segment.from, docLength);
      const to = Math.min(segment.to, docLength);
      if (from >= to) continue;
      builder.add(
        from,
        to,
        Decoration.mark({
          attributes: {
            "data-author": segment.clientId,
            "data-when": String(segment.createdAt ?? ""),
            style: `background: ${authorColor(segment.clientId, 0.18)}; border-bottom: 2px solid ${authorColor(segment.clientId, 0.9)}`,
          },
          class: "cm-redline-ins",
        }),
      );
    }
  }
  return builder.finish();
}

/** shadcn-tooltip-styled hover card: who, when, and (for markers) what. */
function redlineHoverTooltip(): ReturnType<typeof hoverTooltip> {
  return hoverTooltip((view, pos): Tooltip | null => {
    const dom = view.domAtPos(pos);
    const node = dom.node instanceof Element ? dom.node : dom.node.parentElement;
    const marked = (node?.closest?.("[data-author]") ?? null) as HTMLElement | null;
    if (!marked) return null;
    const author = authorLabel(marked.dataset.author ?? "");
    const when = whenLabel(Number(marked.dataset.when) || undefined);
    const deleted = marked.dataset.deleted;
    return {
      above: true,
      create: () => ({ dom: tooltipCard(author, when, deleted) }),
      pos,
    };
  });
}

const REFRESH_DEBOUNCE_MS = 500;

/** Fetch-and-decorate: refreshes after edits settle, maps between fetches. */
export function redlineExtension(connection: CollabConnection) {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet = Decoration.none;
      timer: ReturnType<typeof setTimeout> | null = null;
      done = false;
      generation = 0;
      /** Version-mismatch retries since the last edit: when the peer is stuck
       * (too-large, prolonged recovery) the layer must not poll changes()
       * forever — it goes quiet until the next docChanged. */
      futile = 0;

      constructor(readonly view: EditorView) {
        void this.refresh();
      }

      update(update: ViewUpdate) {
        if (!update.docChanged) return;
        // Keep marks visually anchored while the authoritative fold catches up.
        this.decorations = this.decorations.map(update.changes);
        this.futile = 0;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.refresh(), REFRESH_DEBOUNCE_MS);
      }

      async refresh() {
        if (this.done) return;
        const mine = ++this.generation;
        try {
          const changes = await connection.changes();
          if (this.done || this.generation !== mine) return; // out-of-order
          // Segments are in CONFIRMED-head coordinates: install only when the
          // editor is synced to that head AND has no unacked local ops (their
          // doc positions aren't in the fold yet); otherwise keep the current
          // mapped decorations and try again once the versions agree.
          if (
            changes.headVersion !== getSyncedVersion(this.view.state) ||
            sendableUpdates(this.view.state).length > 0
          ) {
            if (this.futile++ < 20) {
              this.timer = setTimeout(() => void this.refresh(), REFRESH_DEBOUNCE_MS);
            }
            return;
          }
          this.futile = 0;
          const segments: CollabChangeSegment[] = [
            ...changes.inserted.map((span) => ({ ...span, kind: "inserted" as const })),
            ...changes.deleted.map((span) => ({ ...span, kind: "deleted" as const })),
          ];
          this.decorations = decorate(segments, this.view.state.doc.length);
          // Nudge a measure/paint without touching the doc.
          this.view.dispatch({});
        } catch {
          // Attribution is decorative — a failed refresh just tries again on
          // the next edit.
        }
      }

      destroy() {
        this.done = true;
        if (this.timer) clearTimeout(this.timer);
      }
    },
    { decorations: (value) => value.decorations },
  );
  return [plugin, redlineHoverTooltip(), theme];
}

const theme = EditorView.baseTheme({
  ".cm-redline-del": { cursor: "help", fontWeight: "bold", padding: "0 1px" },
  ".cm-redline-ins": { borderRadius: "2px" },
  // shadcn tooltip dialect: primary bg, small radius, xs text.
  ".cm-tooltip:has(.cm-redline-tooltip)": {
    backgroundColor: "transparent",
    border: "none",
  },
  ".cm-redline-tooltip": {
    backgroundColor: "var(--primary, #18181b)",
    borderRadius: "calc(var(--radius, 0.5rem) - 4px)",
    color: "var(--primary-foreground, #fafafa)",
    fontSize: "12px",
    maxWidth: "320px",
    padding: "6px 12px",
  },
  ".cm-redline-tooltip-floating": {
    position: "fixed",
    transform: "translateY(calc(-100% - 6px))",
    zIndex: "70",
  },
  ".cm-redline-tooltip-snippet": {
    marginTop: "4px",
    opacity: "0.8",
    textDecoration: "line-through",
    whiteSpace: "pre-wrap",
  },
});
