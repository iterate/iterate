// The formatting bar's and the shortcuts' commands. The doc is its markdown text, so each one is a
// plain text edit: wrap the selection in `**`, put `## ` in front of a line, insert a table.
import type { EditorView } from "@codemirror/view";

/** Wrap the selection in `marker` (`**` for bold), or unwrap it when it's already wrapped. An empty
 *  selection gets the markers with the cursor between them. */
export function toggleWrap(view: EditorView, marker: string) {
  const { from, to } = view.state.selection.main;
  const n = marker.length;
  const wrapped =
    view.state.sliceDoc(from - n, from) === marker && view.state.sliceDoc(to, to + n) === marker;
  view.dispatch(
    wrapped
      ? {
          changes: [
            { from: from - n, to: from },
            { from: to, to: to + n },
          ],
        }
      : {
          changes: [
            { from, insert: marker },
            { from: to, insert: marker },
          ],
          selection: { anchor: from + n, head: to + n },
        },
  );
  view.focus();
  return true;
}

/** What starts a block line: a heading's `#`s, a quote's `>`, a list item's marker. */
const BLOCK_PREFIX = /^(#{1,6} |> |- \[[ xX]\] |[-*+] |\d+\. )/;

/** Give every selected line `prefix` in place of the block marker it had ("" makes them paragraphs). */
export function setLinePrefix(view: EditorView, prefix: string) {
  const { from, to } = view.state.selection.main;
  const changes = [];
  for (let n = view.state.doc.lineAt(from).number; n <= view.state.doc.lineAt(to).number; n++) {
    const line = view.state.doc.line(n);
    const existing = line.text.match(BLOCK_PREFIX)?.[0] || "";
    changes.push({ from: line.from, to: line.from + existing.length, insert: prefix });
  }
  view.dispatch({ changes });
  view.focus();
  return true;
}

/** A block of markdown on its own after the cursor's line, with blank lines around it. */
export function insertBlock(view: EditorView, block: string) {
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  view.dispatch({
    changes: { from: line.to, insert: `\n\n${block}\n` },
    selection: { anchor: line.to + 2 },
  });
  view.focus();
  return true;
}

/** Make the selection a link to `url`: `[selection](url)`, or `[url](url)` when nothing is selected. */
function insertLink(view: EditorView, url: string) {
  const { from, to } = view.state.selection.main;
  const text = view.state.sliceDoc(from, to) || url;
  view.dispatch({
    changes: { from, to, insert: `[${text}](${url})` },
    selection: { anchor: from + 1, head: from + 1 + text.length },
  });
  view.focus();
  return true;
}

/** Ask for a URL (the browser's own prompt, for now) and make the selection a link to it. */
export function promptLink(view: EditorView) {
  const url = window.prompt("Link URL");
  // cancelled: nothing to do, and the key is still the command's
  if (!url) return true;
  return insertLink(view, url);
}

export const TABLE_TEMPLATE = "| Column | Column |\n| ------ | ------ |\n|        |        |";
