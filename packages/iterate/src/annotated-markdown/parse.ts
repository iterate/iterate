import { parseRestrictedFrontmatterYaml } from "./frontmatter.ts";
import { isSentinelLine, parseSentinelLine } from "./sentinels.ts";
import type {
  Diagnostic,
  Frontmatter,
  ParseResult,
  PlainDocument,
  SourceRange,
  Thread,
  ThreadAnchor,
  ThreadComment,
} from "./types.ts";

// The transactional parser. It tentatively recognizes every structural region
// (front matter, body, EOF discussion store) and only commits a structured
// result when the whole file validates; any structural doubt returns the
// complete original text as a plain document instead. Fallback never rewrites
// a byte: `plain.body === raw` always. Anchor drift is NOT handled here — a
// structurally valid thread whose quote no longer matches is still structured
// (see anchors.ts).

const MAX_FILE_LENGTH = 4 * 1024 * 1024;
const MAX_FRONTMATTER_LENGTH = 128 * 1024;
const MAX_THREADS = 1_000;
const MAX_COMMENTS = 10_000;

interface Line {
  start: number;
  /** End of the line's text, excluding the `\r?\n` ending. */
  contentEnd: number;
  /** End including the line ending (equals contentEnd on the last line). */
  end: number;
}

function splitLines(raw: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  while (start <= raw.length) {
    const nl = raw.indexOf("\n", start);
    if (nl === -1) {
      if (start < raw.length) lines.push({ start, contentEnd: raw.length, end: raw.length });
      break;
    }
    const contentEnd = nl > start && raw[nl - 1] === "\r" ? nl - 1 : nl;
    lines.push({ start, contentEnd, end: nl + 1 });
    start = nl + 1;
  }
  return lines;
}

function isFence(content: string): "open" | "close" | null {
  const trimmed = content.replace(/[ \t]+$/, "");
  if (trimmed === "---") return "close";
  if (trimmed === "...") return "close";
  return null;
}

const THREAD_HEADING = /^### (.+?) · (?:Open|Resolved)$/;

export function parseAnnotatedMarkdown(raw: string): ParseResult {
  const plain = (diagnostic: Diagnostic): PlainDocument => ({
    kind: "plain",
    raw,
    body: raw,
    diagnostics: [diagnostic],
  });
  const lineRange = (line: Line): SourceRange => ({ start: line.start, end: line.contentEnd });

  if (raw.length > MAX_FILE_LENGTH) {
    return plain({
      code: "file-too-large",
      message: `file exceeds ${MAX_FILE_LENGTH} UTF-16 code units`,
    });
  }
  if (!raw.isWellFormed()) {
    return plain({ code: "invalid-text", message: "text contains unpaired surrogates" });
  }

  const lines = splitLines(raw);
  const bomOffset = raw.startsWith("\uFEFF") ? 1 : 0;

  // Front matter: an exact `---` fence on the first line (after an optional
  // BOM), closed by the first `---` or `...` line. An opening fence with no
  // close is fatal — the spec treats unterminated front matter as structural
  // uncertainty, not as body text.
  let frontmatter: Frontmatter | null = null;
  let bodyStart = bomOffset;
  let firstBodyLineIndex = 0;
  const openContent =
    lines[0] === undefined ? null : raw.slice(lines[0].start + bomOffset, lines[0].contentEnd);
  if (
    lines[0] !== undefined &&
    openContent !== null &&
    openContent.replace(/[ \t]+$/, "") === "---"
  ) {
    let closeIndex = -1;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (line !== undefined && isFence(raw.slice(line.start, line.contentEnd)) !== null) {
        closeIndex = i;
        break;
      }
    }
    if (closeIndex === -1) {
      return plain({
        code: "frontmatter-unterminated",
        message: "front matter fence `---` is never closed",
        range: lineRange(lines[0]),
      });
    }
    const closeLine = lines[closeIndex];
    if (closeLine === undefined) throw new Error("unreachable: closeIndex points at a line");
    const contentRange: SourceRange = { start: lines[0].end, end: closeLine.start };
    const contentText = raw.slice(contentRange.start, contentRange.end);
    if (contentText.length > MAX_FRONTMATTER_LENGTH) {
      return plain({
        code: "frontmatter-too-large",
        message: `front matter exceeds ${MAX_FRONTMATTER_LENGTH} UTF-16 code units`,
        range: contentRange,
      });
    }
    const parsed = parseRestrictedFrontmatterYaml(contentText);
    if (!parsed.ok) {
      return plain({ code: parsed.code, message: parsed.message, range: contentRange });
    }
    frontmatter = {
      data: parsed.data,
      document: parsed.document,
      range: { start: lines[0].start, end: closeLine.end },
      contentRange,
    };
    bodyStart = closeLine.end;
    firstBodyLineIndex = closeIndex + 1;
  }

  // Discussion store: sentinel lines are recognized at column 0 only. Any
  // line that starts with the reserved prefix must parse strictly; thread and
  // comment sentinels are only legal inside the (single) store.
  interface OpenThread {
    id: string;
    status: "open" | "resolved";
    beginLine: Line;
    anchor: ThreadAnchor | null;
    comments: ThreadComment[];
    firstCommentLine: Line | null;
  }
  let storeLine: Line | null = null;
  let openThread: OpenThread | null = null;
  let openComment: {
    id: string;
    author: string;
    createdAt: string;
    modifiedAt: string | null;
    inReplyTo: string | null;
    deleted: boolean;
    beginLine: Line;
  } | null = null;
  const threads: Thread[] = [];
  let commentCount = 0;

  const finishComment = (
    comment: NonNullable<typeof openComment>,
    endLine: Line,
  ): ThreadComment => {
    const contentStart = comment.beginLine.end;
    const contentEnd = endLine.start;
    const contentLines = lines.filter((l) => l.start >= contentStart && l.end <= contentEnd);
    let index = 0;
    let headingLine: Line | null = null;
    const first = contentLines[0];
    if (first !== undefined && raw.startsWith("#### ", first.start)) {
      headingLine = first;
      index = 1;
    }
    while (index < contentLines.length) {
      const line = contentLines[index];
      if (line === undefined || raw.slice(line.start, line.contentEnd).trim() !== "") break;
      index++;
    }
    let last = contentLines.length - 1;
    while (last >= index) {
      const line = contentLines[last];
      if (line === undefined || raw.slice(line.start, line.contentEnd).trim() !== "") break;
      last--;
    }
    const firstBody = contentLines[index];
    const lastBody = contentLines[last];
    const bodyRange: SourceRange =
      firstBody !== undefined && lastBody !== undefined && index <= last
        ? { start: firstBody.start, end: lastBody.contentEnd }
        : (() => {
            const at = headingLine !== null ? headingLine.end : contentStart;
            return { start: at, end: at };
          })();
    let displayName: string | null = null;
    if (headingLine !== null) {
      const headingText = raw.slice(headingLine.start + "#### ".length, headingLine.contentEnd);
      const separator = headingText.lastIndexOf(" · ");
      const name = (separator === -1 ? headingText : headingText.slice(0, separator)).trim();
      displayName = name === "" ? null : name;
    }
    return {
      id: comment.id,
      author: comment.author,
      createdAt: comment.createdAt,
      modifiedAt: comment.modifiedAt,
      inReplyTo: comment.inReplyTo,
      deleted: comment.deleted,
      displayName,
      body: raw.slice(bodyRange.start, bodyRange.end),
      range: { start: comment.beginLine.start, end: endLine.end },
      bodyRange,
    };
  };

  const finishThread = (thread: OpenThread, endLine: Line): Thread => {
    const preambleEnd =
      thread.firstCommentLine !== null ? thread.firstCommentLine.start : endLine.start;
    let label: string | null = null;
    for (const line of lines) {
      if (line.start < thread.beginLine.end) continue;
      if (line.end > preambleEnd) break;
      const match = THREAD_HEADING.exec(raw.slice(line.start, line.contentEnd));
      if (match !== null) {
        label = match[1] ?? null;
        break;
      }
    }
    return {
      id: thread.id,
      status: thread.status,
      label,
      anchor: thread.anchor,
      comments: thread.comments,
      range: { start: thread.beginLine.start, end: endLine.end },
    };
  };

  for (let i = firstBodyLineIndex; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const content = raw.slice(line.start, line.contentEnd);
    if (!isSentinelLine(content)) continue;
    const parsed = parseSentinelLine(content, line.start);
    if (!parsed.ok) {
      return plain({ code: parsed.code, message: parsed.message, range: lineRange(line) });
    }
    const token = parsed.token;

    if (token.kind === "store") {
      if (storeLine !== null) {
        return plain({
          code: "store-duplicate",
          message: "more than one task-discussions store",
          range: lineRange(line),
        });
      }
      if (openThread !== null || openComment !== null) {
        throw new Error("unreachable: store sentinel seen before the first store");
      }
      storeLine = line;
      continue;
    }
    if (storeLine === null) {
      return plain({
        code: "sentinel-outside-store",
        message: `${token.kind} sentinel before the task-discussions store`,
        range: lineRange(line),
      });
    }

    if (openComment !== null) {
      if (token.kind === "comment-end") {
        if (token.id !== openComment.id) {
          return plain({
            code: "sentinel-mismatched",
            message: `comment end id=${token.id} does not match open comment id=${openComment.id}`,
            range: lineRange(line),
          });
        }
        if (openThread === null) throw new Error("unreachable: comment open outside a thread");
        openThread.comments.push(finishComment(openComment, line));
        if (openThread.firstCommentLine === null)
          openThread.firstCommentLine = openComment.beginLine;
        openComment = null;
        continue;
      }
      return plain({
        code: "sentinel-unexpected",
        message: `${token.kind} sentinel inside an open comment`,
        range: lineRange(line),
      });
    }

    if (openThread !== null) {
      if (token.kind === "comment-begin") {
        commentCount++;
        if (commentCount > MAX_COMMENTS) {
          return plain({ code: "record-limit", message: `more than ${MAX_COMMENTS} comments` });
        }
        openComment = {
          id: token.id,
          author: token.author,
          createdAt: token.createdAt,
          modifiedAt: token.modifiedAt,
          inReplyTo: token.inReplyTo,
          deleted: token.deleted,
          beginLine: line,
        };
        continue;
      }
      if (token.kind === "anchor") {
        if (openThread.anchor !== null || openThread.firstCommentLine !== null) {
          return plain({
            code: "anchor-misplaced",
            message: "anchor sentinel must appear once, before the thread's first comment",
            range: lineRange(line),
          });
        }
        openThread.anchor = {
          selector: token.selector,
          range: { start: line.start, end: line.end },
        };
        continue;
      }
      if (token.kind === "thread-end") {
        if (token.id !== openThread.id) {
          return plain({
            code: "sentinel-mismatched",
            message: `thread end id=${token.id} does not match open thread id=${openThread.id}`,
            range: lineRange(line),
          });
        }
        threads.push(finishThread(openThread, line));
        openThread = null;
        continue;
      }
      return plain({
        code: "sentinel-unexpected",
        message: `${token.kind} sentinel inside an open thread`,
        range: lineRange(line),
      });
    }

    if (token.kind === "thread-begin") {
      if (threads.length >= MAX_THREADS) {
        return plain({ code: "record-limit", message: `more than ${MAX_THREADS} threads` });
      }
      openThread = {
        id: token.id,
        status: token.status,
        beginLine: line,
        anchor: null,
        comments: [],
        firstCommentLine: null,
      };
      continue;
    }
    return plain({
      code: "sentinel-unexpected",
      message: `${token.kind} sentinel at store level (only thread begin/end may appear here)`,
      range: lineRange(line),
    });
  }

  if (openComment !== null || openThread !== null) {
    return plain({
      code: "sentinel-unterminated",
      message: `end of file inside an open ${openComment !== null ? "comment" : "thread"}`,
    });
  }

  // Identity and reference validation: ids are unique across threads AND
  // comments; replies point at another comment in the same thread.
  const ids = new Set<string>();
  for (const thread of threads) {
    if (ids.has(thread.id)) {
      return plain({
        code: "duplicate-id",
        message: `duplicate id ${thread.id}`,
        range: thread.range,
      });
    }
    ids.add(thread.id);
    for (const comment of thread.comments) {
      if (ids.has(comment.id)) {
        return plain({
          code: "duplicate-id",
          message: `duplicate id ${comment.id}`,
          range: comment.range,
        });
      }
      ids.add(comment.id);
    }
  }
  for (const thread of threads) {
    const commentIds = new Set(thread.comments.map((c) => c.id));
    for (const comment of thread.comments) {
      if (comment.inReplyTo === null) continue;
      if (comment.inReplyTo === comment.id || !commentIds.has(comment.inReplyTo)) {
        return plain({
          code: "invalid-reply",
          message: `comment ${comment.id} replies to ${comment.inReplyTo}, which is not another comment in its thread`,
          range: comment.range,
        });
      }
    }
  }

  const bodyEnd = storeLine !== null ? storeLine.start : raw.length;
  return {
    kind: "structured",
    raw,
    frontmatter,
    body: raw.slice(bodyStart, bodyEnd),
    bodyRange: { start: bodyStart, end: bodyEnd },
    discussion:
      storeLine !== null ? { range: { start: storeLine.start, end: raw.length }, threads } : null,
    diagnostics: [],
  };
}
