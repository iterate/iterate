import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import remarkGfm from "remark-gfm";
import type { Root, RootContent, Code, Table, TableRow, List, ListItem } from "mdast";
import { codeBlock } from "discord.js";

export type ChunkingOptions = {
  maxCharacters: number;
  maxLines?: number;
};

const DEFAULT_OPTIONS: ChunkingOptions = {
  maxCharacters: 2000,
};

function nodeToMarkdown(node: RootContent | Root): string {
  const processor = unified()
    .use(remarkStringify, {
      bullet: "-",
      fences: true,
      listItemIndent: "one",
      rule: "-",
    })
    .use(remarkGfm);

  if (node.type === "root") {
    return processor.stringify(node);
  }

  const root: Root = { type: "root", children: [node] };
  return processor.stringify(root);
}

function countLines(str: string): number {
  if (!str) return 0;
  return str.split("\n").length;
}

function stripTrailingBackslashLineBreaks(markdown: string): string {
  const lines = markdown.split("\n");
  let inFence = false;

  return lines
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (!inFence && line.endsWith("\\")) {
        return line.slice(0, -1);
      }
      return line;
    })
    .join("\n");
}

function wouldExceedLimits(
  currentContent: string,
  newContent: string,
  options: ChunkingOptions,
): boolean {
  const combinedLength = currentContent.length + newContent.length;
  if (combinedLength > options.maxCharacters) {
    return true;
  }
  if (options.maxLines !== undefined) {
    const combinedLines = countLines(currentContent + newContent);
    return combinedLines > options.maxLines;
  }
  return false;
}

function splitCodeBlock(node: Code, options: ChunkingOptions): string[] {
  const lang = node.lang || "";
  const meta = node.meta || "";
  const langLine = lang + (meta ? " " + meta : "");
  const lines = node.value.split("\n");

  const chunks: string[] = [];
  let currentLines: string[] = [];

  for (const line of lines) {
    const testContent = currentLines.length > 0 ? currentLines.join("\n") + "\n" + line : line;
    const testChunk = "```" + langLine + "\n" + testContent + "\n```";

    const totalLines = countLines(testContent) + 2;
    const exceedsLines = options.maxLines !== undefined && totalLines > options.maxLines;

    if (currentLines.length > 0 && (testChunk.length > options.maxCharacters || exceedsLines)) {
      chunks.push("```" + langLine + "\n" + currentLines.join("\n") + "\n```");
      currentLines = [line];
    } else {
      currentLines.push(line);
    }
  }

  if (currentLines.length > 0) {
    chunks.push("```" + langLine + "\n" + currentLines.join("\n") + "\n```");
  }

  return chunks;
}

function wrapTableInCodeBlock(tableMarkdown: string): string {
  return codeBlock(tableMarkdown.trim());
}

function splitTable(node: Table, options: ChunkingOptions): string[] {
  if (node.children.length < 1) {
    return [wrapTableInCodeBlock(nodeToMarkdown(node))];
  }

  const headerRow = node.children[0];
  const dataRows = node.children.slice(1);

  const headerTable: Table = {
    type: "table",
    align: node.align,
    children: [headerRow],
  };
  const headerMarkdown = nodeToMarkdown(headerTable).trim();

  const chunks: string[] = [];
  let currentRows: TableRow[] = [];

  for (const row of dataRows) {
    const testTable: Table = {
      type: "table",
      align: node.align,
      children: [headerRow, ...currentRows, row],
    };
    const testMarkdown = wrapTableInCodeBlock(nodeToMarkdown(testTable));

    const exceedsLines =
      options.maxLines !== undefined && countLines(testMarkdown) > options.maxLines;
    if (currentRows.length > 0 && (testMarkdown.length > options.maxCharacters || exceedsLines)) {
      const chunkTable: Table = {
        type: "table",
        align: node.align,
        children: [headerRow, ...currentRows],
      };
      chunks.push(wrapTableInCodeBlock(nodeToMarkdown(chunkTable)));
      currentRows = [row];
    } else {
      currentRows.push(row);
    }
  }

  if (currentRows.length > 0) {
    const chunkTable: Table = {
      type: "table",
      align: node.align,
      children: [headerRow, ...currentRows],
    };
    chunks.push(wrapTableInCodeBlock(nodeToMarkdown(chunkTable)));
  }

  if (chunks.length === 0) {
    chunks.push(wrapTableInCodeBlock(headerMarkdown));
  }

  return chunks;
}

function splitList(node: List, options: ChunkingOptions): string[] {
  const chunks: string[] = [];
  let currentItems: ListItem[] = [];

  for (const item of node.children) {
    const testList: List = {
      type: "list",
      ordered: node.ordered,
      start: node.start,
      spread: node.spread,
      children: [...currentItems, item],
    };
    const testMarkdown = nodeToMarkdown(testList);

    const exceedsLines =
      options.maxLines !== undefined && countLines(testMarkdown) > options.maxLines;
    if (currentItems.length > 0 && (testMarkdown.length > options.maxCharacters || exceedsLines)) {
      const chunkList: List = {
        type: "list",
        ordered: node.ordered,
        start: node.start,
        spread: node.spread,
        children: currentItems,
      };
      chunks.push(nodeToMarkdown(chunkList));
      currentItems = [item];
    } else {
      currentItems.push(item);
    }
  }

  if (currentItems.length > 0) {
    const chunkList: List = {
      type: "list",
      ordered: node.ordered,
      start: node.start,
      spread: node.spread,
      children: currentItems,
    };
    chunks.push(nodeToMarkdown(chunkList));
  }

  return chunks;
}

function processNode(node: RootContent, options: ChunkingOptions): string[] {
  if (node.type === "table") {
    const wrapped = wrapTableInCodeBlock(nodeToMarkdown(node));
    const exceedsLines = options.maxLines !== undefined && countLines(wrapped) > options.maxLines;
    if (wrapped.length <= options.maxCharacters && !exceedsLines) {
      return [wrapped];
    }
    return splitTable(node, options);
  }

  const markdown = nodeToMarkdown(node);

  const exceedsLines = options.maxLines !== undefined && countLines(markdown) > options.maxLines;
  if (markdown.length <= options.maxCharacters && !exceedsLines) {
    return [markdown];
  }

  switch (node.type) {
    case "code":
      return splitCodeBlock(node, options);

    case "list":
      return splitList(node, options);

    default:
      return [markdown];
  }
}

export function chunkMarkdown(markdown: string, options?: Partial<ChunkingOptions>): string[] {
  const opts: ChunkingOptions = { ...DEFAULT_OPTIONS, ...options };

  const processor = unified().use(remarkParse).use(remarkGfm);
  const tree = processor.parse(markdown);

  const chunks: string[] = [];
  let currentChunkNodes: RootContent[] = [];
  let currentChunkContent = "";

  function flushChunk() {
    if (currentChunkNodes.length > 0) {
      const root: Root = { type: "root", children: currentChunkNodes };
      chunks.push(stripTrailingBackslashLineBreaks(nodeToMarkdown(root).trim()));
      currentChunkNodes = [];
      currentChunkContent = "";
    }
  }

  for (const node of tree.children) {
    const nodeChunks = processNode(node, opts);

    for (const content of nodeChunks) {
      const exceedsLines = opts.maxLines !== undefined && countLines(content) > opts.maxLines;
      if (content.length > opts.maxCharacters || exceedsLines) {
        flushChunk();
        chunks.push(stripTrailingBackslashLineBreaks(content.trim()));
        continue;
      }

      if (currentChunkContent && wouldExceedLimits(currentChunkContent, "\n\n" + content, opts)) {
        flushChunk();
      }

      const needsRawHandling = nodeChunks.length > 1 || node.type === "table";

      if (needsRawHandling) {
        if (currentChunkContent) {
          currentChunkContent += "\n\n" + content;
        } else {
          currentChunkContent = content;
        }
        if (currentChunkNodes.length === 0) {
          const subTree = processor.parse(content);
          currentChunkNodes.push(...subTree.children);
        } else {
          flushChunk();
          const subTree = processor.parse(content);
          currentChunkNodes.push(...subTree.children);
          currentChunkContent = content;
        }
      } else {
        if (currentChunkContent) {
          currentChunkContent += "\n\n";
        }
        currentChunkContent += content;
        currentChunkNodes.push(node);
      }
    }
  }

  flushChunk();

  return chunks.map((chunk) => stripTrailingBackslashLineBreaks(chunk));
}
