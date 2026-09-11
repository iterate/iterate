import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import { applyReviewOperation } from "iterate/document-review";
import { describe, expect, it, test } from "vitest";
import { markdownTables, moveTableCell } from "./markdown-tables.ts";
import { projectedMarkdown } from "./rfm-projected-markdown.ts";

function createState(source: string): EditorState {
  return EditorState.create({
    doc: source,
    extensions: [markdown({ base: markdownLanguage }), markdownTables()],
  });
}

function tableNodes(state: EditorState, name: string): { from: number; to: number }[] {
  const nodes: { from: number; to: number }[] = [];
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name === name) nodes.push({ from: node.from, to: node.to });
    },
  });
  return nodes;
}

function decorationsAt(
  state: EditorState,
  position: number,
): { attributes?: { class?: string; style?: string } }[] {
  const decorations: { attributes?: { class?: string; style?: string } }[] = [];
  for (const source of state.facet(EditorView.decorations)) {
    const set = typeof source === "function" ? source({ state } as EditorView) : source;
    set.between(position, position + 1, (from, _to, value) => {
      if (from === position) decorations.push(value.spec);
    });
  }
  return decorations;
}

function atomicRanges(state: EditorState): { from: number; to: number }[] {
  const ranges: { from: number; to: number }[] = [];
  for (const source of state.facet(EditorView.atomicRanges)) {
    source({ state } as EditorView).between(0, state.doc.length, (from, to) => {
      ranges.push({ from, to });
    });
  }
  return ranges;
}

function commented(source: string, passage: string) {
  const from = source.indexOf(passage);
  const result = applyReviewOperation(source, {
    type: "add-selected-comment",
    expectedSource: source,
    range: { start: from, end: from + passage.length },
    author: "Ada",
    body: "Please review | this.",
    createdAt: "2026-09-09T02:00:00Z",
  });
  if (!result.ok) throw new Error(result.message);
  return result.source;
}

function createProjectedState(source: string): EditorState {
  return EditorState.create({ doc: source, extensions: [projectedMarkdown(), markdownTables()] });
}

describe("markdownTables", () => {
  it("keeps the table as a normal Markdown source document", () => {
    const source = `| Name | Owner |\n| --- | --- |\n| Alice | Ada |`;
    const state = createState(source);
    const from = source.indexOf("Alice");
    const next = state.update({ changes: { from, to: from + 5, insert: "Alicia" } }).state;

    expect(tableNodes(state, "Table")).toHaveLength(1);
    expect(next.doc.toString()).toBe(source.replace("Alice", "Alicia"));
    expect(tableNodes(next, "TableCell")).toHaveLength(4);
  });

  it("uses lezer's escape-aware cells and keeps an empty field", () => {
    const source = `| A | B | C |\n| --- | --- | --- |\n| x\\|y || z |`;
    const state = createState(source);

    // `\\|` is a literal pipe. The empty middle field has no TableCell node.
    expect(tableNodes(state, "TableCell")).toHaveLength(5);
    expect(tableNodes(state, "TableDelimiter")).toHaveLength(9);
  });

  it("recognizes an even backslash run before a pipe as structural", () => {
    const source = `| A | B | C |\n| --- | --- | --- |\n| x\\\\| y | z |`;
    const state = createState(source);

    expect(tableNodes(state, "TableCell")).toHaveLength(6);
  });

  it("supports GFM tables without outer pipes", () => {
    const state = createState(`Name | Owner\n--- | ---\nAlice | Ada`);
    expect(tableNodes(state, "TableCell")).toHaveLength(4);
  });

  it("moves Tab and Shift-Tab through native source positions", () => {
    const source = `| Name | Owner |\n| --- | --- |\n| Alice | Ada |`;
    let state = createState(source);
    const alice = source.indexOf("Alice");
    const ada = source.indexOf("Ada");
    state = state.update({ selection: { anchor: alice + 2 } }).state;
    const view = {
      get state() {
        return state;
      },
      dispatch(spec: Parameters<EditorState["update"]>[0]) {
        state = state.update(spec).state;
      },
    };

    // The command only needs CodeMirror's state/dispatch pair. This avoids a
    // DOM harness while exercising the public keymap command's source offsets.
    expect(moveTableCell(view as never, 1)).toBe(true);
    expect(state.selection.main.head).toBe(ada);
    expect(moveTableCell(view as never, -1)).toBe(true);
    expect(state.selection.main.head).toBe(alice + "Alice".length);

    state = state.update({ selection: { anchor: ada } }).state;
    expect(moveTableCell(view as never, 1)).toBe(false);
  });

  it("removes the native table presentation when the divider is deleted", () => {
    const source = `| Name | Owner |\n| --- | --- |\n| Alice | Ada |`;
    const state = createState(source);
    const marker = source.indexOf("---");
    const next = state.update({ changes: { from: marker, to: marker + 3 } }).state;

    expect(tableNodes(next, "Table")).toHaveLength(0);
  });

  it("registers the hidden divider as an atomic range for arrow navigation", () => {
    const source = `| Name | Owner |\n| --- | --- |\n| Alice | Ada |`;
    const state = createState(source);
    const from = source.indexOf("| ---");
    expect(atomicRanges(state)).toEqual([{ from, to: from + "| --- | --- |".length }]);
  });

  it("does not add a cell for whitespace after the final pipe", () => {
    const source = `| A | B |\n| --- | --- |\n| x | y |  `;
    const state = createState(source);
    const rowStarts = [0, source.indexOf("| x")];

    expect(tableNodes(state, "Table")).toHaveLength(1);

    for (const rowStart of rowStarts) {
      expect(decorationsAt(state, rowStart)).toContainEqual({
        attributes: expect.objectContaining({ style: "--markdown-table-columns: 2" }),
      });
    }
  });

  it("drops table decorations when a fence opener changes the parse above it", () => {
    const source = `\n| A | B |\n| --- | --- |\n| x | y |\n`;
    const state = createState(source);
    const next = state.update({ changes: { from: 0, insert: "```\n" } }).state;

    expect(tableNodes(next, "Table")).toHaveLength(0);
    expect(atomicRanges(next)).toEqual([]);
  });

  it("uses projected GFM delimiters when a hidden comment contains a pipe", () => {
    const source = commented(`| Name | Owner |\n| --- | --- |\n| Alpha | Jonas |\n`, "Alpha");
    const state = createProjectedState(source);
    const alpha = source.indexOf("Alpha");
    const jonas = source.indexOf("Jonas");
    let selected = state.update({ selection: { anchor: alpha } }).state;
    const view = {
      get state() {
        return selected;
      },
      dispatch(spec: Parameters<EditorState["update"]>[0]) {
        selected = selected.update(spec).state;
      },
    };

    expect(tableNodes(state, "TableCell")).toHaveLength(4);
    expect(moveTableCell(view as never, 1)).toBe(true);
    expect(selected.selection.main.head).toBe(jonas);
  });

  test.for(["| Alpha | Jonas |", "| Name | Owner |\n| --- | --- |\n| Alpha | Jonas |"])(
    "keeps a projected whole-row or whole-table anchor structurally navigable",
    (passage) => {
      const source = commented(`| Name | Owner |\n| --- | --- |\n| Alpha | Jonas |\n`, passage);
      const state = createProjectedState(source);

      expect(tableNodes(state, "Table")).toHaveLength(1);
      expect(tableNodes(state, "TableCell")).toHaveLength(4);
      const rowStart = state.doc.lineAt(source.indexOf("Alpha")).from;
      expect(decorationsAt(state, rowStart)).toContainEqual({
        attributes: expect.objectContaining({
          class: "cm-markdown-table-row",
          style: "--markdown-table-columns: 2",
        }),
      });
    },
  );
});
