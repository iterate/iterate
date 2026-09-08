/** @jsxImportSource react */
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import type { Nodes, Parents, RootContent } from "mdast";
import type { ReactNode } from "react";
import {
  BLOCK_END_ATTRIBUTE,
  BLOCK_START_ATTRIBUTE,
  SOURCE_ATOMIC_ATTRIBUTE,
  SOURCE_END_ATTRIBUTE,
  SOURCE_START_ATTRIBUTE,
} from "../lib/document-projection.ts";

interface RenderContext {
  markdown: string;
}

function offsetsOf(node: Nodes) {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (typeof start !== "number" || typeof end !== "number") return null;
  return { start, end };
}

function nodeKey(node: Nodes, fallback: number) {
  return node.position?.start.offset ?? fallback;
}

function SourceText({
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
  return (
    <span
      {...{
        [SOURCE_START_ATTRIBUTE]: start,
        [SOURCE_END_ATTRIBUTE]: end,
        ...(atomic && { [SOURCE_ATOMIC_ATTRIBUTE]: "" }),
      }}
    >
      {value}
    </span>
  );
}

function text(ctx: RenderContext, node: Nodes & { value: string }): ReactNode {
  const offsets = offsetsOf(node);
  if (offsets === null) return node.value;
  const source = ctx.markdown.slice(offsets.start, offsets.end);
  if (source === node.value)
    return <SourceText value={node.value} start={offsets.start} end={offsets.end} atomic={false} />;

  if (node.value.includes("\n")) {
    const lines = node.value.split("\n");
    const aligned: ReactNode[] = [];
    let cursor = 0;
    for (const [index, line] of lines.entries()) {
      const at = line === "" ? cursor : source.indexOf(line, cursor);
      if (at === -1)
        return <SourceText value={node.value} start={offsets.start} end={offsets.end} atomic />;
      if (line !== "") {
        aligned.push(
          <SourceText
            key={aligned.length}
            value={line}
            start={offsets.start + at}
            end={offsets.start + at + line.length}
            atomic={false}
          />,
        );
        cursor = at + line.length;
      }
      if (index < lines.length - 1) {
        const newline = source.indexOf("\n", cursor);
        const next = lines[index + 1] ?? "";
        const nextAt = next === "" ? newline + 1 : source.indexOf(next, newline + 1);
        if (newline === -1 || nextAt === -1)
          return <SourceText value={node.value} start={offsets.start} end={offsets.end} atomic />;
        aligned.push(
          <SourceText
            key={aligned.length}
            value="\n"
            start={offsets.start + cursor}
            end={offsets.start + nextAt}
            atomic
          />,
        );
        cursor = nextAt;
      }
    }
    return <>{aligned}</>;
  }

  // Entities and escapes decode before rendering. Preserve an exact prefix and
  // suffix so a single entity does not make a full paragraph unselectable.
  let prefix = 0;
  const maximum = Math.min(source.length, node.value.length);
  while (prefix < maximum && source[prefix] === node.value[prefix]) prefix += 1;
  // An HTML entity decodes from several source characters to one visible `&`.
  // The shared ampersand is its visible character, so move it into the atomic
  // segment rather than mapping its DOM offset to the plain-text prefix.
  const entityStart = prefix - 1;
  if (
    entityStart >= 0 &&
    /^&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]+);/i.test(source.slice(entityStart))
  ) {
    prefix = entityStart;
  }
  let suffix = 0;
  while (
    suffix < maximum - prefix &&
    source[source.length - suffix - 1] === node.value[node.value.length - suffix - 1]
  )
    suffix += 1;
  const middle = node.value.slice(prefix, node.value.length - suffix);
  if (middle.length === 0)
    return <SourceText value={node.value} start={offsets.start} end={offsets.end} atomic />;
  return (
    <>
      {prefix > 0 ? (
        <SourceText
          value={node.value.slice(0, prefix)}
          start={offsets.start}
          end={offsets.start + prefix}
          atomic={false}
        />
      ) : null}
      <SourceText value={middle} start={offsets.start + prefix} end={offsets.end - suffix} atomic />
      {suffix > 0 ? (
        <SourceText
          value={node.value.slice(node.value.length - suffix)}
          start={offsets.end - suffix}
          end={offsets.end}
          atomic={false}
        />
      ) : null}
    </>
  );
}

function inlineCode(ctx: RenderContext, node: Nodes & { value: string }, afterFirstLine = false) {
  const offsets = offsetsOf(node);
  if (offsets === null) return node.value;
  const source = ctx.markdown.slice(offsets.start, offsets.end);
  const firstLineEnd = source.indexOf("\n");
  const searchFrom =
    afterFirstLine && /^[`~]/.test(source) && firstLineEnd !== -1 ? firstLineEnd + 1 : 0;
  const index = source.indexOf(node.value, searchFrom);
  if (index === -1)
    return <SourceText value={node.value} start={offsets.start} end={offsets.end} atomic />;
  return (
    <SourceText
      value={node.value}
      start={offsets.start + index}
      end={offsets.start + index + node.value.length}
      atomic={false}
    />
  );
}

function blockAttributes(node: Nodes) {
  const offsets = offsetsOf(node);
  if (offsets === null) return {};
  return { [BLOCK_START_ATTRIBUTE]: offsets.start, [BLOCK_END_ATTRIBUTE]: offsets.end };
}

function children(ctx: RenderContext, node: Parents) {
  return node.children.map((child, index) => (
    <Node key={nodeKey(child, index)} ctx={ctx} node={child} />
  ));
}

const safeLink = /^(https?:\/\/|mailto:|#)/i;
const safeImage = /^https?:\/\//i;

function Node({ ctx, node }: { ctx: RenderContext; node: RootContent }): ReactNode {
  switch (node.type) {
    case "text":
      return text(ctx, node);
    case "paragraph":
      return <p {...blockAttributes(node)}>{children(ctx, node)}</p>;
    case "heading": {
      // mdast guarantees heading depth 1–6. JSX cannot infer that template
      // literal union, so this narrow cast is the smallest safe bridge.
      const Tag = `h${node.depth}` as "h1";
      return <Tag {...blockAttributes(node)}>{children(ctx, node)}</Tag>;
    }
    case "emphasis":
      return <em>{children(ctx, node)}</em>;
    case "strong":
      return <strong>{children(ctx, node)}</strong>;
    case "delete":
      return <del>{children(ctx, node)}</del>;
    case "inlineCode":
      return <code>{inlineCode(ctx, node)}</code>;
    case "code":
      return (
        <pre {...blockAttributes(node)}>
          <code>{inlineCode(ctx, node, true)}</code>
        </pre>
      );
    case "blockquote":
      return <blockquote {...blockAttributes(node)}>{children(ctx, node)}</blockquote>;
    case "list": {
      const Tag = node.ordered === true ? "ol" : "ul";
      return (
        <Tag
          {...blockAttributes(node)}
          start={node.ordered === true ? (node.start ?? 1) : undefined}
        >
          {children(ctx, node)}
        </Tag>
      );
    }
    case "listItem": {
      const checkbox =
        node.checked === true || node.checked === false ? (
          <input type="checkbox" checked={node.checked} readOnly disabled aria-hidden />
        ) : null;
      const [firstChild, ...remaining] = node.children;
      const content =
        checkbox !== null && firstChild?.type === "paragraph" ? (
          <>
            <span {...blockAttributes(firstChild)}>{children(ctx, firstChild)}</span>
            {remaining.map((child, index) => (
              <Node key={nodeKey(child, index)} ctx={ctx} node={child} />
            ))}
          </>
        ) : (
          children(ctx, node)
        );
      return (
        <li {...blockAttributes(node)} data-task={checkbox === null ? undefined : ""}>
          {checkbox}
          {content}
        </li>
      );
    }
    case "link": {
      if (!safeLink.test(node.url)) return <span>{children(ctx, node)}</span>;
      const external = /^https?:\/\//i.test(node.url);
      return (
        <a
          href={node.url}
          title={node.title ?? undefined}
          target={external ? "_blank" : undefined}
          rel={external ? "noreferrer" : undefined}
        >
          {children(ctx, node)}
        </a>
      );
    }
    case "image":
      return safeImage.test(node.url) ? (
        <img src={node.url} alt={node.alt ?? ""} title={node.title ?? undefined} />
      ) : (
        <span>{node.alt ?? node.url}</span>
      );
    case "break":
      return <br />;
    case "thematicBreak":
      return <hr {...blockAttributes(node)} />;
    case "table": {
      const [head, ...rows] = node.children;
      return (
        <table {...blockAttributes(node)}>
          {head ? (
            <thead>
              <tr>
                {head.children.map((cell, index) => (
                  <th key={nodeKey(cell, index)} align={node.align?.[index] ?? undefined}>
                    {children(ctx, cell)}
                  </th>
                ))}
              </tr>
            </thead>
          ) : null}
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={nodeKey(row, rowIndex)}>
                {row.children.map((cell, cellIndex) => (
                  <td key={nodeKey(cell, cellIndex)} align={node.align?.[cellIndex] ?? undefined}>
                    {children(ctx, cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
    }
    case "html":
      return <code data-raw-html="">{text(ctx, node)}</code>;
    case "definition":
      return null;
    default:
      return "children" in node ? <span>{children(ctx, node)}</span> : null;
  }
}

/** Renders Markdown into safe semantic React elements stamped with source offsets. */
export function MarkdownDocumentRenderer({
  markdown,
  className,
}: {
  markdown: string;
  className?: string;
}) {
  const tree = fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  const ctx = { markdown } satisfies RenderContext;
  return (
    <div className={className} data-document-renderer="">
      {tree.children.map((child, index) => (
        <Node key={nodeKey(child, index)} ctx={ctx} node={child} />
      ))}
    </div>
  );
}
