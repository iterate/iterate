import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import {
  Prec,
  StateField,
  type EditorState,
  type Extension,
  type Range,
  type Transaction,
} from "@codemirror/state";
import { Decoration, EditorView, keymap, WidgetType, type DecorationSet } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";

interface TableDecorations {
  decorations: DecorationSet;
  outer: DecorationSet;
  atomic: DecorationSet;
  ranges: { from: number; to: number }[];
}

class EmptyTableCell extends WidgetType {
  override eq(): boolean {
    return true;
  }

  override toDOM(): HTMLElement {
    const cell = document.createElement("span");
    cell.className = "cm-markdown-table-cell cm-markdown-table-empty-cell";
    cell.setAttribute("aria-hidden", "true");
    cell.textContent = "\u200b";
    return cell;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

class HiddenTableDivider extends WidgetType {
  override eq(): boolean {
    return true;
  }

  override toDOM(): HTMLElement {
    const divider = document.createElement("div");
    divider.className = "cm-markdown-table-divider";
    divider.setAttribute("aria-hidden", "true");
    return divider;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

function directChildren(node: SyntaxNode, name: string): SyntaxNode[] {
  const children: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === name) children.push(child);
  }
  return children;
}

/** Fields are the source spans between GFM parser delimiters, not raw `|` scans. */
function tableFields(state: EditorState, row: SyntaxNode): { from: number; to: number }[] {
  const fields: { from: number; to: number }[] = [];
  let start = row.from;
  let end = row.to;
  while (end > start && /\s/.test(state.doc.sliceString(end - 1, end))) end--;
  let first = true;
  for (const delimiter of directChildren(row, "TableDelimiter")) {
    // The first outer pipe opens a field. Later adjacent pipes are empty fields.
    if (!(first && start === delimiter.from)) fields.push({ from: start, to: delimiter.from });
    start = delimiter.to;
    first = false;
  }
  if (start < end) fields.push({ from: start, to: end });
  return fields;
}

function editableFields(state: EditorState, row: SyntaxNode): { from: number; to: number }[] {
  const cells = directChildren(row, "TableCell");
  return tableFields(state, row).map((field) => {
    const cell = cells.find(
      (candidate) => candidate.from >= field.from && candidate.to <= field.to,
    );
    if (cell) return { from: cell.from, to: cell.to };

    let from = field.from;
    let to = field.to;
    while (from < to && /\s/.test(state.doc.sliceString(from, from + 1))) from++;
    while (to > from && /\s/.test(state.doc.sliceString(to - 1, to))) to--;
    return { from, to };
  });
}

function tableRows(table: SyntaxNode): SyntaxNode[] {
  return [...directChildren(table, "TableHeader"), ...directChildren(table, "TableRow")];
}

function buildTables(state: EditorState): TableDecorations {
  const regular: Range<Decoration>[] = [];
  const outer: Range<Decoration>[] = [];
  const atomic: Range<Decoration>[] = [];
  const ranges: { from: number; to: number }[] = [];
  const tree = ensureSyntaxTree(state, state.doc.length, 200) ?? syntaxTree(state);

  tree.iterate({
    enter(node) {
      if (node.name !== "Table") return;
      const table = node.node;
      const rows = tableRows(table);
      if (rows.length === 0) return false;
      const columns = Math.max(1, ...rows.map((row) => tableFields(state, row).length));
      ranges.push({ from: table.from, to: table.to });

      for (const row of rows) {
        regular.push(
          Decoration.line({
            attributes: {
              class:
                row.name === "TableHeader"
                  ? "cm-markdown-table-row cm-markdown-table-header"
                  : "cm-markdown-table-row",
              style: `--markdown-table-columns: ${columns}`,
            },
          }).range(state.doc.lineAt(row.from).from),
        );
        for (const delimiter of directChildren(row, "TableDelimiter"))
          regular.push(
            Decoration.mark({ class: "cm-markdown-table-pipe" }).range(
              delimiter.from,
              delimiter.to,
            ),
          );
        for (const field of tableFields(state, row)) {
          if (field.from === field.to) {
            outer.push(
              Decoration.widget({ side: 1, widget: new EmptyTableCell() }).range(field.from),
            );
          } else {
            outer.push(
              Decoration.mark({ class: "cm-markdown-table-cell" }).range(field.from, field.to),
            );
          }
        }
      }

      const divider = directChildren(table, "TableDelimiter")[0];
      if (divider) {
        const decoration = Decoration.replace({ block: true, widget: new HiddenTableDivider() });
        regular.push(decoration.range(divider.from, divider.to));
        atomic.push(decoration.range(divider.from, divider.to));
      }
      return false;
    },
  });

  return {
    decorations: Decoration.set(regular, true),
    outer: Decoration.set(outer, true),
    atomic: Decoration.set(atomic, true),
    ranges,
  };
}

function changesAffectTables(value: TableDecorations, transaction: Transaction): boolean {
  let affected = false;
  transaction.changes.iterChanges((fromA, toA, fromB, _toB, inserted) => {
    if (affected) return;
    if (value.ranges.some((range) => fromA <= range.to && toA >= range.from)) {
      affected = true;
      return;
    }
    const before = transaction.startState.doc.lineAt(
      Math.min(fromA, transaction.startState.doc.length),
    ).text;
    const after = transaction.state.doc.lineAt(Math.min(fromB, transaction.state.doc.length)).text;
    if (before.includes("|") || after.includes("|") || inserted.toString().includes("\n"))
      affected = true;
  });
  return affected;
}

function rangesStillTables(state: EditorState, ranges: { from: number; to: number }[]): boolean {
  const tree = syntaxTree(state);
  return ranges.every((range) => {
    for (
      let node: SyntaxNode | null = tree.resolveInner(Math.min(range.from, state.doc.length), 1);
      node;
      node = node.parent
    ) {
      if (node.name === "Table") return true;
    }
    return false;
  });
}

const tables = StateField.define<TableDecorations>({
  create: buildTables,
  update(value, transaction) {
    if (!transaction.docChanged) {
      return syntaxTree(transaction.state) === syntaxTree(transaction.startState)
        ? value
        : buildTables(transaction.state);
    }
    if (changesAffectTables(value, transaction)) return buildTables(transaction.state);
    const mapped = {
      decorations: value.decorations.map(transaction.changes),
      outer: value.outer.map(transaction.changes),
      atomic: value.atomic.map(transaction.changes),
      ranges: value.ranges.map((range) => ({
        from: transaction.changes.mapPos(range.from, 1),
        to: transaction.changes.mapPos(range.to, -1),
      })),
    };
    return rangesStillTables(transaction.state, mapped.ranges)
      ? mapped
      : buildTables(transaction.state);
  },
  provide(field) {
    return [
      EditorView.decorations.from(field, (value) => value.decorations),
      EditorView.outerDecorations.from(field, (value) => value.outer),
      EditorView.atomicRanges.of((view) => view.state.field(field).atomic),
    ];
  },
});

function tableCells(state: EditorState): { from: number; to: number }[] {
  const cells: { from: number; to: number }[] = [];
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== "Table") return;
      for (const row of tableRows(node.node)) cells.push(...editableFields(state, row));
      return false;
    },
  });
  return cells;
}

export function moveTableCell(view: EditorView, direction: 1 | -1): boolean {
  const selection = view.state.selection.main;
  if (!selection.empty) return false;
  const cells = tableCells(view.state);
  const index = cells.findIndex((cell) => cell.from <= selection.head && selection.head <= cell.to);
  const target = cells[index + direction];
  if (index < 0 || !target) return false;
  view.dispatch({
    selection: { anchor: direction === 1 ? target.from : target.to },
    scrollIntoView: true,
  });
  return true;
}

/** Native GFM table presentation. The Markdown text remains CodeMirror's only buffer. */
export function markdownTables(): Extension {
  return [
    tables,
    Prec.high(
      keymap.of([
        { key: "Tab", run: (view) => moveTableCell(view, 1) },
        { key: "Shift-Tab", run: (view) => moveTableCell(view, -1) },
      ]),
    ),
    tableTheme,
  ];
}

const tableTheme = EditorView.baseTheme({
  ".cm-markdown-table-row": {
    boxSizing: "border-box",
    margin: "0",
    maxWidth: "100%",
    width: "min(100%, 56rem)",
  },
  ".cm-markdown-table-cell": {
    border: "1px solid color-mix(in srgb, currentColor 18%, transparent)",
    boxSizing: "border-box",
    display: "inline-block",
    maxWidth: "100%",
    minWidth: "0",
    padding: "0.35rem 0.6rem",
    verticalAlign: "top",
    width: "calc(100% / var(--markdown-table-columns))",
  },
  ".cm-markdown-table-header .cm-markdown-table-cell": {
    background: "color-mix(in srgb, currentColor 7%, transparent)",
    fontWeight: "650",
  },
  ".cm-markdown-table-divider": { height: "0", minHeight: "0", overflow: "hidden" },
  ".cm-markdown-table-pipe": { display: "none" },
});
