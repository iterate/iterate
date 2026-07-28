import type { AnchorSelector, DiagnosticCode, SourceRange } from "./types.ts";

// Sentinel lines are the machine boundaries of the discussion store:
//
//   <!-- task-discussions:v1 -->
//   <!-- task-thread:v1 begin id=th_X status=open -->
//   <!-- task-anchor:v1 {"quote":{...}} -->
//   <!-- task-comment:v1 begin id=cm_Y author=lee created=2026-07-28T08:30:00Z -->
//   <!-- task-comment:v1 end id=cm_Y -->
//   <!-- task-thread:v1 end id=th_X -->
//
// A sentinel occupies a whole line starting at column 0. Anything that starts
// with the reserved prefix but fails strict parsing is a fatal diagnostic —
// the caller falls back to a plain document rather than guessing. `--` is
// forbidden anywhere inside the comment because HTML comments cannot contain
// it; anchor JSON escapes double hyphens as `--` when writing.

const SENTINEL_PREFIX = "<!-- task-";

const SENTINEL_SUFFIX = " -->";
const MAX_ID_LENGTH = 128;
const MAX_AUTHOR_LENGTH = 320;
const MAX_ANCHOR_JSON_LENGTH = 16 * 1024;
const MAX_QUOTE_EXACT_LENGTH = 4096;
const MAX_QUOTE_CONTEXT_LENGTH = 1024;

type SentinelToken =
  | { kind: "store" }
  | {
      kind: "thread-begin";
      id: string;
      status: "open" | "resolved";
      /** Absolute range of the status value, for minimal status splices. */
      statusValueRange: SourceRange;
      /** Absolute offset just before ` -->`, for appending an attribute. */
      attrsEnd: number;
    }
  | { kind: "thread-end"; id: string }
  | {
      kind: "comment-begin";
      id: string;
      author: string;
      createdAt: string;
      inReplyTo: string | null;
      deleted: boolean;
      attrsEnd: number;
    }
  | { kind: "comment-end"; id: string }
  | { kind: "anchor"; selector: AnchorSelector };

type SentinelParse =
  | { ok: true; token: SentinelToken }
  | { ok: false; code: DiagnosticCode; message: string };

export function isSentinelLine(lineContent: string): boolean {
  return lineContent.startsWith(SENTINEL_PREFIX);
}

export function isValidId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) &&
    !value.includes("--")
  );
}

export function isValidAuthor(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_AUTHOR_LENGTH &&
    !/\s/.test(value) &&
    !value.includes("--")
  );
}

export function isValidCreatedAt(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?Z$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

export function validateAnchorSelector(value: unknown): AnchorSelector | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.some((k) => k !== "quote" && k !== "position")) return null;
  const { quote, position } = value as { quote?: unknown; position?: unknown };
  if (typeof quote !== "object" || quote === null || Array.isArray(quote)) return null;
  const quoteKeys = Object.keys(quote);
  if (quoteKeys.some((k) => k !== "exact" && k !== "prefix" && k !== "suffix")) return null;
  const { exact, prefix, suffix } = quote as {
    exact?: unknown;
    prefix?: unknown;
    suffix?: unknown;
  };
  if (typeof exact !== "string" || exact.length === 0 || exact.length > MAX_QUOTE_EXACT_LENGTH) {
    return null;
  }
  if (typeof prefix !== "string" || prefix.length > MAX_QUOTE_CONTEXT_LENGTH) return null;
  if (typeof suffix !== "string" || suffix.length > MAX_QUOTE_CONTEXT_LENGTH) return null;
  const selector: AnchorSelector = { quote: { exact, prefix, suffix } };
  if (position !== undefined) {
    if (typeof position !== "object" || position === null || Array.isArray(position)) return null;
    const positionKeys = Object.keys(position);
    if (positionKeys.some((k) => k !== "start" && k !== "end")) return null;
    const { start, end } = position as { start?: unknown; end?: unknown };
    if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
    if ((start as number) < 0 || (end as number) < (start as number)) return null;
    selector.position = { start: start as number, end: end as number };
  }
  return selector;
}

/**
 * Parse one sentinel line. `lineContent` is the line without its ending;
 * `lineStart` is its absolute offset, used to compute absolute sub-ranges.
 */
export function parseSentinelLine(lineContent: string, lineStart: number): SentinelParse {
  const malformed = (message: string): SentinelParse => ({
    ok: false,
    code: "sentinel-malformed",
    message: `${message} in sentinel: ${lineContent.length > 120 ? `${lineContent.slice(0, 120)}…` : lineContent}`,
  });
  if (!lineContent.endsWith(SENTINEL_SUFFIX)) {
    return malformed("missing ` -->` terminator");
  }
  const inner = lineContent.slice(SENTINEL_PREFIX.length - "task-".length, -SENTINEL_SUFFIX.length);
  if (inner.includes("--")) {
    return malformed("`--` is not allowed inside an HTML comment");
  }
  const spaceIndex = inner.indexOf(" ");
  const head = spaceIndex === -1 ? inner : inner.slice(0, spaceIndex);
  const rest = spaceIndex === -1 ? "" : inner.slice(spaceIndex + 1);
  const headParts = head.split(":");
  if (headParts.length !== 2) return malformed("expected `task-<kind>:<version>`");
  const [tag, version] = headParts as [string, string];
  if (
    tag !== "task-discussions" &&
    tag !== "task-thread" &&
    tag !== "task-comment" &&
    tag !== "task-anchor"
  ) {
    return malformed(`unknown sentinel kind \`${tag}\``);
  }
  if (!/^v\d+$/.test(version)) return malformed(`invalid version \`${version}\``);
  if (version !== "v1") {
    return {
      ok: false,
      code: "sentinel-unsupported-version",
      message: `unsupported ${tag} version \`${version}\` (this codec understands v1)`,
    };
  }

  if (tag === "task-discussions") {
    if (spaceIndex !== -1) return malformed("task-discussions takes no attributes");
    return { ok: true, token: { kind: "store" } };
  }

  if (tag === "task-anchor") {
    if (rest.length === 0 || rest.length > MAX_ANCHOR_JSON_LENGTH) {
      return {
        ok: false,
        code: "anchor-invalid",
        message: "anchor selector JSON missing or too large",
      };
    }
    if (rest !== rest.trim()) {
      return {
        ok: false,
        code: "anchor-invalid",
        message: "anchor selector JSON has stray whitespace",
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rest);
    } catch {
      return { ok: false, code: "anchor-invalid", message: "anchor selector is not valid JSON" };
    }
    const selector = validateAnchorSelector(parsed);
    if (selector === null) {
      return { ok: false, code: "anchor-invalid", message: "anchor selector has an invalid shape" };
    }
    return { ok: true, token: { kind: "anchor", selector } };
  }

  // task-thread / task-comment: `begin <attrs>` or `end <attrs>`, single
  // spaces, `key=value` tokens with no duplicate or unknown keys.
  const restStart = SENTINEL_PREFIX.length - "task-".length + head.length + 1;
  const tokens: { text: string; start: number }[] = [];
  if (rest !== "") {
    let cursor = 0;
    for (const text of rest.split(" ")) {
      if (text === "") return malformed("expected single spaces between attributes");
      tokens.push({ text, start: restStart + cursor });
      cursor += text.length + 1;
    }
  }
  const mode = tokens.shift()?.text;
  if (mode !== "begin" && mode !== "end") return malformed("expected `begin` or `end`");
  const attrs = new Map<string, { value: string; valueStart: number }>();
  for (const token of tokens) {
    const eq = token.text.indexOf("=");
    if (eq <= 0 || eq === token.text.length - 1)
      return malformed(`expected \`key=value\`, got \`${token.text}\``);
    const key = token.text.slice(0, eq);
    if (attrs.has(key)) return malformed(`duplicate attribute \`${key}\``);
    attrs.set(key, { value: token.text.slice(eq + 1), valueStart: token.start + eq + 1 });
  }
  const attrsEnd = lineStart + lineContent.length - SENTINEL_SUFFIX.length;
  const take = (key: string): { value: string; valueStart: number } | undefined => {
    const entry = attrs.get(key);
    attrs.delete(key);
    return entry;
  };
  const id = take("id");
  if (id === undefined || !isValidId(id.value)) return malformed("missing or invalid `id`");

  if (mode === "end") {
    if (attrs.size > 0)
      return malformed(`unknown attribute \`${[...attrs.keys()][0]}\` on end sentinel`);
    return {
      ok: true,
      token: { kind: tag === "task-thread" ? "thread-end" : "comment-end", id: id.value },
    };
  }

  if (tag === "task-thread") {
    const status = take("status");
    if (status === undefined || (status.value !== "open" && status.value !== "resolved")) {
      return malformed("thread `status` must be `open` or `resolved`");
    }
    if (attrs.size > 0)
      return malformed(`unknown attribute \`${[...attrs.keys()][0]}\` on thread begin`);
    return {
      ok: true,
      token: {
        kind: "thread-begin",
        id: id.value,
        status: status.value,
        statusValueRange: {
          start: lineStart + status.valueStart,
          end: lineStart + status.valueStart + status.value.length,
        },
        attrsEnd,
      },
    };
  }

  const author = take("author");
  if (author === undefined || !isValidAuthor(author.value))
    return malformed("missing or invalid `author`");
  const created = take("created");
  if (created === undefined || !isValidCreatedAt(created.value)) {
    return malformed("`created` must be an ISO-8601 UTC instant like 2026-07-28T08:30:00Z");
  }
  const inReplyTo = take("in-reply-to");
  if (inReplyTo !== undefined && !isValidId(inReplyTo.value))
    return malformed("invalid `in-reply-to`");
  const deleted = take("deleted");
  if (deleted !== undefined && deleted.value !== "true")
    return malformed("`deleted` may only be `true`");
  if (attrs.size > 0)
    return malformed(`unknown attribute \`${[...attrs.keys()][0]}\` on comment begin`);
  return {
    ok: true,
    token: {
      kind: "comment-begin",
      id: id.value,
      author: author.value,
      createdAt: created.value,
      inReplyTo: inReplyTo?.value ?? null,
      deleted: deleted !== undefined,
      attrsEnd,
    },
  };
}

export function formatStoreSentinel(): string {
  return "<!-- task-discussions:v1 -->";
}

export function formatThreadBegin(id: string, status: "open" | "resolved"): string {
  return `<!-- task-thread:v1 begin id=${id} status=${status} -->`;
}

export function formatThreadEnd(id: string): string {
  return `<!-- task-thread:v1 end id=${id} -->`;
}

export function formatCommentBegin(comment: {
  id: string;
  author: string;
  createdAt: string;
  inReplyTo?: string | null;
  deleted?: boolean;
}): string {
  let attrs = `id=${comment.id} author=${comment.author} created=${comment.createdAt}`;
  if (comment.inReplyTo != null) attrs += ` in-reply-to=${comment.inReplyTo}`;
  if (comment.deleted === true) attrs += " deleted=true";
  return `<!-- task-comment:v1 begin ${attrs} -->`;
}

export function formatCommentEnd(id: string): string {
  return `<!-- task-comment:v1 end id=${id} -->`;
}

export function formatAnchorSentinel(selector: AnchorSelector): string {
  const canonical: AnchorSelector = { quote: { ...selector.quote } };
  if (selector.position !== undefined) canonical.position = { ...selector.position };
  // `--` cannot appear inside an HTML comment; JSON only produces it inside
  // string literals, where a `-` escape is transparent to JSON.parse.
  const json = JSON.stringify(canonical).replace(/-(?=-)/g, "\\u002d");
  return `<!-- task-anchor:v1 ${json} -->`;
}
