/** @jsxImportSource react */
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import type { Nodes, Parents, RootContent } from "mdast";
import type { ReactNode } from "react";

// A markdown renderer whose one job beyond looking clean is SOURCE FIDELITY:
// every rendered text run is wrapped in a span stamped with the body-relative
// source offsets it came from, and every block element carries its block's
// range. The projection module reads those stamps back off the live DOM to
// map selections to source and source ranges to paintable DOM ranges — the
// renderer never guesses by comparing text after the fact.
//
// Sanitization is by construction: markdown is rendered from the mdast tree
// to React elements only. Raw HTML in the source is shown as literal code
// text, never parsed into the DOM; only http(s)/mailto/# links and http(s)
// images survive as active references.

/** data attribute names shared with projection.ts. */
export const SEGMENT_START_ATTR = "data-ams";
export const SEGMENT_END_ATTR = "data-ame";
export const SEGMENT_ATOMIC_ATTR = "data-amx";
export const BLOCK_START_ATTR = "data-amb";
export const BLOCK_END_ATTR = "data-ambe";

interface RenderContext {
  /** The body markdown exactly as parsed. */
  source: string;
}

const offsetsOf = (node: Nodes): { start: number; end: number } | null => {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (typeof start !== "number" || typeof end !== "number") return null;
  return { start, end };
};

/**
 * A stamped text run. `atomic` marks runs whose rendered characters do NOT
 * map 1:1 onto the source slice (entity/escape decoding, fence trimming) —
 * the projection then treats the run as a single indivisible unit and snaps
 * selection boundaries to its edges instead of inventing offsets.
 */
function Segment({
  value,
  start,
  end,
  atomic,
}: {
  value: string;
  start: number;
  end: number;
  atomic: boolean;
}) {
  const attrs: Record<string, string | number> = {
    [SEGMENT_START_ATTR]: start,
    [SEGMENT_END_ATTR]: end,
  };
  if (atomic) attrs[SEGMENT_ATOMIC_ATTR] = "";
  return <span {...attrs}>{value}</span>;
}

function textSegment(ctx: RenderContext, node: Nodes & { value: string }): ReactNode {
  const offsets = offsetsOf(node);
  if (offsets === null) return node.value;
  const slice = ctx.source.slice(offsets.start, offsets.end);
  if (slice === node.value) {
    return <Segment value={node.value} start={offsets.start} end={offsets.end} atomic={false} />;
  }
  // Multiline mismatch: blockquote `> ` continuations (and list lazy
  // indents) live in the SOURCE between the value's lines. Align line by
  // line — each rendered line maps exactly, and each newline becomes an
  // atomic unit covering the newline plus the structural prefix.
  if (node.value.includes("\n")) {
    const lineSegments = alignLines(node.value, slice, offsets.start);
    if (lineSegments !== null) return <>{lineSegments}</>;
  }
  // Decoded text (an entity, an escape): keep the identical prefix and
  // suffix as exact segments so only the decoded core snaps atomically —
  // one `&amp;` must not make a whole paragraph indivisible.
  const value = node.value;
  let prefix = 0;
  const maxShared = Math.min(slice.length, value.length);
  while (prefix < maxShared && slice[prefix] === value[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < maxShared - prefix &&
    slice[slice.length - 1 - suffix] === value[value.length - 1 - suffix]
  ) {
    suffix++;
  }
  // Greedy ends can meet in the middle (`&` matching into `&amp;`); shrink
  // until both cores are non-empty so the atomic unit exists.
  while (
    prefix + suffix > 0 &&
    (value.length - prefix - suffix <= 0 || slice.length - prefix - suffix <= 0)
  ) {
    if (suffix > 0) suffix--;
    else prefix--;
  }
  const coreValue = value.slice(prefix, value.length - suffix);
  const coreSlice = slice.slice(prefix, slice.length - suffix);
  if (coreValue.length === 0 || coreSlice.length === 0) {
    return <Segment value={value} start={offsets.start} end={offsets.end} atomic={true} />;
  }
  return (
    <>
      {prefix > 0 ? (
        <Segment
          value={value.slice(0, prefix)}
          start={offsets.start}
          end={offsets.start + prefix}
          atomic={false}
        />
      ) : null}
      <Segment
        value={coreValue}
        start={offsets.start + prefix}
        end={offsets.end - suffix}
        atomic={true}
      />
      {suffix > 0 ? (
        <Segment
          value={value.slice(value.length - suffix)}
          start={offsets.end - suffix}
          end={offsets.end}
          atomic={false}
        />
      ) : null}
    </>
  );
}

/**
 * Map a multiline text value onto its source slice line by line. Every value
 * line must appear in order in the slice (blockquote/list prefixes only ever
 * sit BETWEEN lines); returns null when it doesn't so the caller falls back
 * to prefix/suffix splitting.
 */
function alignLines(value: string, slice: string, sliceStart: number) {
  const lines = value.split("\n");
  const segments: ReactNode[] = [];
  let cursor = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const at = line === "" ? cursor : slice.indexOf(line, cursor);
    if (at === -1) return null;
    if (line !== "") {
      segments.push(
        <Segment
          key={segments.length}
          value={line}
          start={sliceStart + at}
          end={sliceStart + at + line.length}
          atomic={false}
        />,
      );
      cursor = at + line.length;
    }
    if (i < lines.length - 1) {
      const gapEnd = slice.indexOf("\n", cursor);
      if (gapEnd === -1) return null;
      const nextLine = lines[i + 1] ?? "";
      const nextAt = nextLine === "" ? gapEnd + 1 : slice.indexOf(nextLine, gapEnd + 1);
      if (nextAt === -1) return null;
      segments.push(
        <Segment
          key={segments.length}
          value={"\n"}
          start={sliceStart + cursor}
          end={sliceStart + nextAt}
          atomic={true}
        />,
      );
      cursor = nextAt;
    }
  }
  return segments;
}

/**
 * Inline code / fenced code carry their content INSIDE delimiters; locate the
 * verbatim content within the node's slice so the segment maps exactly, and
 * fall back to an atomic whole-node segment when it isn't contiguous
 * (indented code blocks, exotic escapes). Fenced content starts on the line
 * AFTER the opening fence — searching from the top would bind a body that
 * echoes the info string (```python whose body is `python`) to the fence.
 */
function innerSegment(
  ctx: RenderContext,
  node: Nodes & { value: string },
  { afterFirstLine = false }: { afterFirstLine?: boolean } = {},
): { segment: ReactNode } {
  const offsets = offsetsOf(node);
  if (offsets === null) return { segment: node.value };
  const slice = ctx.source.slice(offsets.start, offsets.end);
  let searchFrom = 0;
  // Indented code blocks have no fence line — only skip a real one.
  if (afterFirstLine && /^[`~]/.test(slice)) {
    const firstLineEnd = slice.indexOf("\n");
    searchFrom = firstLineEnd === -1 ? slice.length : firstLineEnd + 1;
  }
  const inner = node.value.length === 0 ? -1 : slice.indexOf(node.value, searchFrom);
  if (inner === -1) {
    return {
      segment: <Segment value={node.value} start={offsets.start} end={offsets.end} atomic={true} />,
    };
  }
  return {
    segment: (
      <Segment
        value={node.value}
        start={offsets.start + inner}
        end={offsets.start + inner + node.value.length}
        atomic={false}
      />
    ),
  };
}

const SAFE_LINK = /^(https?:\/\/|mailto:|#)/i;
const SAFE_IMAGE = /^https?:\/\//i;

function renderChildren(ctx: RenderContext, node: Parents): ReactNode[] {
  return node.children.map((child, index) => <RenderNode key={index} ctx={ctx} node={child} />);
}

function blockAttrs(node: Nodes): Record<string, number> {
  const offsets = offsetsOf(node);
  if (offsets === null) return {};
  return { [BLOCK_START_ATTR]: offsets.start, [BLOCK_END_ATTR]: offsets.end };
}

function RenderNode({ ctx, node }: { ctx: RenderContext; node: RootContent }): ReactNode {
  switch (node.type) {
    case "text":
      return textSegment(ctx, node);
    case "paragraph":
      return <p {...blockAttrs(node)}>{renderChildren(ctx, node)}</p>;
    case "heading": {
      // mdast constrains depth to 1..6, so the template yields h1–h6; they
      // share h1's prop type, and the single-literal cast keeps JSX typing
      // without enumerating six branches.
      const Tag = `h${node.depth}` as "h1";
      return <Tag {...blockAttrs(node)}>{renderChildren(ctx, node)}</Tag>;
    }
    case "emphasis":
      return <em>{renderChildren(ctx, node)}</em>;
    case "strong":
      return <strong>{renderChildren(ctx, node)}</strong>;
    case "delete":
      return <del>{renderChildren(ctx, node)}</del>;
    case "inlineCode":
      return <code>{innerSegment(ctx, node).segment}</code>;
    case "code": {
      const { segment } = innerSegment(ctx, node, { afterFirstLine: true });
      return (
        <pre {...blockAttrs(node)} data-language={node.lang ?? undefined}>
          <code>{segment}</code>
        </pre>
      );
    }
    case "blockquote":
      return <blockquote {...blockAttrs(node)}>{renderChildren(ctx, node)}</blockquote>;
    case "list": {
      const Tag = node.ordered === true ? "ol" : "ul";
      return (
        <Tag {...blockAttrs(node)} start={node.ordered === true ? (node.start ?? 1) : undefined}>
          {renderChildren(ctx, node)}
        </Tag>
      );
    }
    case "listItem": {
      const checkbox =
        node.checked === true || node.checked === false ? (
          <input type="checkbox" checked={node.checked} readOnly disabled aria-hidden />
        ) : null;
      return (
        <li {...blockAttrs(node)} data-task={checkbox === null ? undefined : ""}>
          {checkbox}
          {renderChildren(ctx, node)}
        </li>
      );
    }
    case "link": {
      const safe = SAFE_LINK.test(node.url);
      if (!safe) return <span>{renderChildren(ctx, node)}</span>;
      const external = /^https?:\/\//i.test(node.url);
      return (
        <a
          href={node.url}
          title={node.title ?? undefined}
          target={external ? "_blank" : undefined}
          rel={external ? "noreferrer" : undefined}
        >
          {renderChildren(ctx, node)}
        </a>
      );
    }
    case "image": {
      if (!SAFE_IMAGE.test(node.url)) {
        return <span>{node.alt ?? node.url}</span>;
      }
      return <img src={node.url} alt={node.alt ?? ""} title={node.title ?? undefined} />;
    }
    case "break":
      return <br />;
    case "thematicBreak":
      return <hr {...blockAttrs(node)} />;
    case "table": {
      const [head, ...rows] = node.children;
      return (
        <table {...blockAttrs(node)}>
          {head !== undefined ? (
            <thead>
              <tr>
                {head.children.map((cell, index) => (
                  <th key={index} align={node.align?.[index] ?? undefined}>
                    {renderChildren(ctx, cell)}
                  </th>
                ))}
              </tr>
            </thead>
          ) : null}
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.children.map((cell, cellIndex) => (
                  <td key={cellIndex} align={node.align?.[cellIndex] ?? undefined}>
                    {renderChildren(ctx, cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
    }
    case "html":
      // Never parsed into the DOM — shown as what it is: source text.
      return <code data-raw-html="">{textSegment(ctx, node)}</code>;
    case "footnoteReference":
    case "footnoteDefinition":
    case "definition":
    case "imageReference":
    case "linkReference":
      // Reference-style constructs are rare in task files; render their
      // readable children (or nothing for pure definitions).
      return "children" in node ? <span>{renderChildren(ctx, node)}</span> : null;
    case "tableRow":
    case "tableCell":
      // Handled inside `table`; unreachable as direct children.
      return null;
    default:
      return null;
  }
}

/**
 * Render annotated-markdown BODY text (front matter and discussion store
 * already sliced off by the codec) as clean, source-stamped HTML. Styling is
 * the host's: the wrapper is plain semantic HTML under `className`.
 */
export function AnnotatedMarkdownView({
  source,
  className,
}: {
  source: string;
  className?: string;
}) {
  const tree = fromMarkdown(source, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  const ctx: RenderContext = { source };
  return (
    <div className={className} data-annotated-markdown-root="">
      {tree.children.map((child, index) => (
        <RenderNode key={index} ctx={ctx} node={child} />
      ))}
    </div>
  );
}
