/**
 * Extracts a best-effort preview message from a *partial* agent code snippet.
 *
 * While a code-mode agent streams its itx script token by token, the snippet
 * often begins with a chat message — `await itx.chat.sendMessage("Checking
 * your email now...")` — either as the first real statement or as the first
 * entry of a `Promise.all([` (the contract prompt pairs a progress message
 * with slow work that way). This pre-parses the UNCLOSED call, pretending a
 * closing `")` exists, and returns the partial string literal so the feed can
 * render it as a live chat-message preview. The sendMessage has NOT run yet —
 * it's honest fakery; when the script actually runs, the real
 * web-message-sent event supersedes it.
 *
 * Deliberately conservative: returns null for anything unrecognized,
 * including the legacy object form `sendMessage({ message: ... })`. A second
 * options argument after the string — `sendMessage("hello", { whatever:
 * 123 })` — is fine: the preview is still just the first string literal.
 *
 * A preview can appear and then VANISH: any preview of an unclosed literal
 * can be invalidated by a later token. `` `hi ${name}` `` previews `"hi "`
 * right up until `${` streams in (the interpolated value is unknowable
 * before the script runs), and `"hi" + name` previews `"hi"` until the `+`
 * arrives — both then revert to null and the bubble disappears. Bail-to-null
 * is the honest choice; only for snippets that stay recognizable is the
 * preview a monotonically growing slice of the final message.
 *
 * `literalClosed` reports whether the closing quote has streamed in yet.
 * While it's false the preview bubble IS the whole story — the feed hides
 * the streaming code block so the message doesn't show twice. Even after the
 * close the block stays hidden through trailing punctuation and whitespace
 * (`");`, newlines, `}`, the closing fence) — otherwise it would flash in
 * just to render a semicolon and a brace before the turn ends. `redactedCode`
 * flips non-null once a word character (`\w`) streams in after the close,
 * i.e. real further code is coming: it's the partial snippet with the message
 * literal replaced by `...` — reading `itx.chat.sendMessage(...)` — since the
 * message text already lives in the bubble. Display-only fakery for the live
 * stream; the settled "Ran code" view shows the unmodified script.
 */
export function extractStreamingSendMessagePreview(
  partialCode: string,
): { message: string; literalClosed: boolean; redactedCode: string | null } | null {
  const text = partialCode;
  let i = skipWhitespace(text, 0);

  // Leading markdown fence (```js). While the fence line itself is still
  // streaming — "`", "``", or "```type" with no newline yet — we can't see
  // past it, so no preview yet.
  if (text.startsWith("```", i)) {
    const newline = text.indexOf("\n", i);
    if (newline === -1) return null;
    i = newline + 1;
  } else if (i < text.length && "```".startsWith(text.slice(i))) {
    return null;
  }

  i = skipTrivia(text, i);
  if (i === -1) return null;

  const wrapper = matchAt(text, i, WRAPPER_OPENER_PATTERN);
  if (wrapper != null) {
    i += wrapper.length;
    i = skipTrivia(text, i);
    if (i === -1) return null;
  }

  const promiseAll = matchAt(text, i, PROMISE_ALL_OPENER_PATTERN);
  if (promiseAll != null) {
    i += promiseAll.length;
    i = skipTrivia(text, i);
    if (i === -1) return null;
  }

  const head = matchAt(text, i, SEND_MESSAGE_HEAD_PATTERN);
  if (head == null) return null;
  i += head.length;

  const quote = text[i];
  if (quote !== '"' && quote !== "'" && quote !== "`") return null;
  const literal = readStringLiteral(text, i + 1, quote);
  if (literal == null) return null;
  if (literal.endOfClose == null) {
    return { message: literal.message, literalClosed: false, redactedCode: null };
  }
  const tail = text.slice(literal.endOfClose);
  return {
    message: literal.message,
    literalClosed: true,
    redactedCode: /\w/.test(tail) ? text.slice(0, i) + "..." + tail : null,
  };
}

/** `async (itx) => {` and friends (`export default async itx => {`). */
const WRAPPER_OPENER_PATTERN =
  /(?:export\s+default\s+)?async\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{/y;

/**
 * `await Promise.all([`, optionally assigned — `const [, inbox] = await
 * Promise.all([` per the contract-prompt progress-message pattern.
 */
const PROMISE_ALL_OPENER_PATTERN =
  /(?:(?:const|let|var)\s+[\w$\s,[\]{}]*?=\s*)?(?:await\s+)?Promise\s*\.\s*all\s*\(\s*\[/y;

const SEND_MESSAGE_HEAD_PATTERN =
  /(?:await\s+)?(?:void\s+)?itx\s*\.\s*chat\s*\.\s*sendMessage\s*\(\s*/y;

function matchAt(text: string, index: number, pattern: RegExp): string | null {
  pattern.lastIndex = index;
  const match = pattern.exec(text);
  return match == null ? null : match[0];
}

function skipWhitespace(text: string, index: number): number {
  let i = index;
  while (i < text.length && /\s/.test(text[i])) i += 1;
  return i;
}

/**
 * Skips whitespace and comments. Returns -1 while a comment is still
 * streaming (unterminated `/*`, a line comment with no newline yet, or a lone
 * `/` at end of input) — we can't see past it, so the caller bails for now.
 */
function skipTrivia(text: string, index: number): number {
  let i = index;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    if (c !== "/") return i;
    const next = text[i + 1];
    if (next === "/") {
      const newline = text.indexOf("\n", i + 2);
      if (newline === -1) return -1;
      i = newline + 1;
    } else if (next === "*") {
      const close = text.indexOf("*/", i + 2);
      if (close === -1) return -1;
      i = close + 2;
    } else if (next === undefined) {
      return -1;
    } else {
      return i;
    }
  }
  return i;
}

/**
 * Reads the (possibly unclosed) string literal starting just after the
 * opening quote, processing standard escapes so the preview reads clean.
 * Mid-stream rules: an unclosed literal previews what's streamed so far; a
 * half-streamed escape (dangling `\`, partial `\u1F...`) or a `$` that might
 * become `${` stops the preview *before* it — the next chunk re-derives and
 * picks those characters back up.
 *
 * `endOfClose` is the index just past the closing quote once it has streamed
 * in (null while the literal is still open) — the caller redacts the literal
 * out of the display code by splicing around it.
 */
function readStringLiteral(
  text: string,
  start: number,
  quote: string,
): { message: string; endOfClose: number | null } | null {
  let out = "";
  let i = start;
  while (i < text.length) {
    const c = text[i];
    if (c === quote) {
      return literalCloseLooksWellFormed(text, i + 1) ? { message: out, endOfClose: i + 1 } : null;
    }
    if (c === "\\") {
      const escape = readEscape(text, i + 1);
      if (escape === "malformed") return null;
      if (escape === "incomplete") return { message: out, endOfClose: null };
      out += escape.value;
      i = escape.next;
      continue;
    }
    if ((c === "\n" || c === "\r") && quote !== "`") return null;
    if (quote === "`" && c === "$") {
      if (i + 1 >= text.length) return { message: out, endOfClose: null };
      if (text[i + 1] === "{") return null;
    }
    out += c;
    i += 1;
  }
  return { message: out, endOfClose: null };
}

/**
 * After the literal closes, the call must still look like
 * `sendMessage("...")` or `sendMessage("...", options)` — a `)` or `,` (or
 * nothing yet, mid-stream). Anything else (`"hi" + name`) means the literal
 * wasn't the whole message, so drop the preview.
 */
function literalCloseLooksWellFormed(text: string, index: number): boolean {
  const i = skipWhitespace(text, index);
  if (i >= text.length) return true;
  return text[i] === ")" || text[i] === ",";
}

type EscapeResult = { value: string; next: number } | "incomplete" | "malformed";

function readEscape(text: string, index: number): EscapeResult {
  if (index >= text.length) return "incomplete";
  const c = text[index];
  const simple: Record<string, string> = {
    n: "\n",
    t: "\t",
    r: "\r",
    b: "\b",
    f: "\f",
    v: "\v",
    "0": "\0",
  };
  if (c in simple) return { value: simple[c], next: index + 1 };
  // Line continuation: backslash-newline contributes nothing.
  if (c === "\n") return { value: "", next: index + 1 };
  if (c === "\r") return { value: "", next: text[index + 1] === "\n" ? index + 2 : index + 1 };
  if (c === "u") {
    if (text[index + 1] === "{") {
      const close = text.indexOf("}", index + 2);
      if (close === -1) {
        return /^[0-9a-fA-F]*$/.test(text.slice(index + 2)) ? "incomplete" : "malformed";
      }
      const hex = text.slice(index + 2, close);
      if (!/^[0-9a-fA-F]+$/.test(hex)) return "malformed";
      const codePoint = parseInt(hex, 16);
      if (codePoint > 0x10ffff) return "malformed";
      return { value: String.fromCodePoint(codePoint), next: close + 1 };
    }
    return readFixedHexEscape(text, index + 1, 4);
  }
  if (c === "x") return readFixedHexEscape(text, index + 1, 2);
  // JS treats unknown escapes as the character itself — covers \" \' \` \\ \$.
  return { value: c, next: index + 1 };
}

function readFixedHexEscape(text: string, index: number, length: number): EscapeResult {
  const hex = text.slice(index, index + length);
  if (hex.length < length) {
    return /^[0-9a-fA-F]*$/.test(hex) ? "incomplete" : "malformed";
  }
  if (!/^[0-9a-fA-F]+$/.test(hex)) return "malformed";
  return { value: String.fromCharCode(parseInt(hex, 16)), next: index + length };
}
