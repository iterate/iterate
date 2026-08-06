// Markdown → plain text for push-notification bodies. iOS notifications have
// no inline rich text at all (the bold line in a push is the TITLE's own
// styling), so markers can only ever render literally — `**Berlin**` on a
// lock screen.
//
// Parsing is the same mdast/micromark stack the repo already renders markdown
// with (packages/iterate annotated-markdown) — hand-rolled regexes get
// CommonMark's edge cases wrong (code spans, intraword emphasis, `__dunders__`).
// This module only decides how each node LOOKS as plain text: formatting
// unwraps to its content, links and images reduce to their text, code is kept
// verbatim, blocks separate with blank lines, list items keep a marker.
import type { RootContent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

export function markdownToPlainText(markdown: string): string {
  const tree = fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  return blocks(tree.children)
    .replaceAll(/\n{3,}/g, "\n\n")
    .trim();
}

function blocks(nodes: RootContent[]): string {
  return nodes.map((node) => block(node)).join("");
}

function block(node: RootContent): string {
  switch (node.type) {
    case "paragraph":
    case "heading":
      return `${inline(node.children)}\n\n`;
    case "code":
      // Fenced/indented code: the content verbatim, rails dropped.
      return `${node.value}\n\n`;
    case "blockquote":
      return blocks(node.children);
    case "list": {
      const items = node.children.map((item, index) => {
        const marker =
          node.ordered === true
            ? `${(typeof node.start === "number" ? node.start : 1) + index}.`
            : "-";
        // A list item's blocks flatten onto one line per item.
        return `${marker} ${blocks(item.children).trim().replaceAll(/\n+/g, " ")}\n`;
      });
      return `${items.join("")}\n`;
    }
    case "table": {
      const rows = node.children.map(
        (row) => `${row.children.map((cell) => inline(cell.children)).join(" · ")}\n`,
      );
      return `${rows.join("")}\n`;
    }
    case "thematicBreak":
      return "";
    case "html":
      return `${node.value}\n\n`;
    default:
      // Anything unanticipated (footnote definitions etc.): its text, at worst.
      return `${inline("children" in node ? node.children : [])}\n\n`;
  }
}

function inline(nodes: RootContent[]): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case "text":
        case "inlineCode":
          // inlineCode verbatim — markers inside code spans are content.
          return node.value;
        case "emphasis":
        case "strong":
        case "delete":
        case "link":
        case "linkReference":
          return inline(node.children);
        case "image":
          return node.alt || "";
        case "break":
          return "\n";
        case "html":
          return node.value;
        default:
          return inline("children" in node ? node.children : []);
      }
    })
    .join("");
}
