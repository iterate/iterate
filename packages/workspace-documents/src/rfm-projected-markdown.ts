import { DocInput, Language, LanguageSupport } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { highlightMarkdown } from "@atomic-editor/editor";
import { Parser, Tree, TreeFragment, type Input, type SyntaxNode } from "@lezer/common";
import { readReview, type DocumentReview } from "iterate/document-review";
import { textEdits } from "./text-edits.ts";
import { reviewForDocument } from "./rfm-document.ts";

/** Map a rendered Markdown boundary into the sole editable source document. */
function sourcePosition(review: DocumentReview, pos: number, side: -1 | 1) {
  for (const segment of review.projection.segments) {
    const { start, end } = segment.display;
    if (side > 0 ? start <= pos && pos < end : start < pos && pos <= end) {
      if (segment.atomic && pos !== start && pos !== end) return null;
      return (
        review.body.range.start +
        segment.source.start +
        (segment.atomic && pos === end ? segment.source.end - segment.source.start : pos - start)
      );
    }
  }
  return pos === 0 ? review.body.range.start : review.body.range.end;
}

/** Map source parser requests across hidden controls without making them editable. */
function displayPosition(review: DocumentReview, pos: number) {
  const bodyPos = pos - review.body.range.start;
  for (const segment of review.projection.segments) {
    const { source, display } = segment;
    if (bodyPos <= source.start) return display.start;
    if (bodyPos < source.end) {
      return segment.atomic ? display.start : display.start + bodyPos - source.start;
    }
  }
  return review.projection.markdown.length;
}

/** A projected parse retained only as long as CodeMirror retains its source syntax tree. */
interface ProjectedParse {
  markdown: string;
  tree: Tree;
}

/** Parse display Markdown, but expose syntax nodes in original file coordinates. */
export function projectedMarkdown() {
  const support = markdown({ base: markdownLanguage, extensions: highlightMarkdown });
  const previousParses = new WeakMap<Tree, ProjectedParse>();
  class ReviewMarkdownParser extends Parser {
    createParse(
      input: Input,
      fragments: readonly TreeFragment[],
      ranges: readonly { from: number; to: number }[],
    ) {
      const source = input.read(0, input.length);
      const review = input instanceof DocInput ? reviewForDocument(input.doc) : readReview(source);
      const projection = review.projection;
      if (
        projection.markdown === source ||
        review.diagnostics.some((d) => d.severity === "error")
      ) {
        return support.language.parser.startParse(
          input,
          fragments.filter((f) => !previousParses.has(f.tree)),
          ranges,
        );
      }

      // Reuse the underlying Markdown parse after diffing the immutable display
      // strings. The document itself is never serialized from this syntax tree.
      const previous = fragments.map((f) => previousParses.get(f.tree)).find(Boolean);
      let reusable: readonly TreeFragment[] = [];
      if (previous) {
        let delta = 0;
        const changed = textEdits(previous.markdown, projection.markdown).map((edit) => {
          const fromB = edit.from + delta;
          delta += edit.insert.length - (edit.to - edit.from);
          return { fromA: edit.from, toA: edit.to, fromB, toB: fromB + edit.insert.length };
        });
        reusable = TreeFragment.applyChanges(TreeFragment.addTree(previous.tree), changed);
      }
      const projectedRanges = ranges.flatMap((range) => {
        const from = displayPosition(review, range.from);
        const to = displayPosition(review, range.to);
        return from < to ? [{ from, to }] : [];
      });
      const base = support.language.parser.startParse(
        projection.markdown,
        reusable,
        projectedRanges,
      );
      const projectedStart = projectedRanges[0]?.from ?? 0;
      const sourceStart = ranges[0]?.from ?? 0;
      let stoppedAt: number | null = null;

      function mapNode(node: SyntaxNode, root = false): { tree: Tree; from: number } | null {
        const displayFrom = node.from + projectedStart;
        const displayTo = node.to + projectedStart;
        const from = root ? sourceStart : sourcePosition(review, displayFrom, 1);
        const to =
          root && displayTo === projection.markdown.length
            ? input.length
            : sourcePosition(review, displayTo, -1);
        if (from === null || to === null || to < from) return null;
        // Most blocks live wholly within one unchanged source segment. Reusing
        // their actual trees preserves nested props and avoids walking every
        // inline token in a large document on every keystroke.
        if (
          !root &&
          projection.segments.some(
            (s) => !s.atomic && s.display.start <= displayFrom && s.display.end >= displayTo,
          )
        ) {
          return { from, tree: node.toTree() };
        }
        const children: Tree[] = [];
        const positions: number[] = [];
        for (let child = node.firstChild; child; child = child.nextSibling) {
          const mapped = mapNode(child);
          if (mapped) {
            children.push(mapped.tree);
            positions.push(mapped.from - from);
          }
        }
        return {
          from,
          tree: new Tree(node.type, children, positions, to - from, node.toTree().propValues),
        };
      }

      return {
        get parsedPos() {
          return base.parsedPos >= projection.markdown.length
            ? input.length
            : (sourcePosition(review, base.parsedPos, -1) ?? sourceStart);
        },
        get stoppedAt() {
          return stoppedAt;
        },
        stopAt(pos: number) {
          stoppedAt = pos;
          base.stopAt(displayPosition(review, pos));
        },
        advance() {
          const tree = base.advance();
          if (!tree) return null;
          const result = mapNode(tree.topNode, true)!.tree;
          if (
            sourceStart === 0 &&
            projectedStart === 0 &&
            tree.length === projection.markdown.length
          ) {
            previousParses.set(result, { markdown: projection.markdown, tree });
          }
          return result;
        },
      };
    }
  }
  return new LanguageSupport(
    new Language(support.language.data, new ReviewMarkdownParser()),
    support.support,
  );
}
