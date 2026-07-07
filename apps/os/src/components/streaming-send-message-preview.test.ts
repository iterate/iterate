// The agent feed pre-parses a *streaming* code snippet: when the first real
// statement is `itx.chat.sendMessage("...` (possibly still unclosed), the
// partial string literal renders as a live chat-message preview. These tests
// simulate token-by-token growth by extracting over successive prefixes of a
// full snippet — helpers at the bottom.

import { expect, test } from "vitest";
import { extractStreamingSendMessagePreview } from "./streaming-send-message-preview.ts";

test("streams the leading sendMessage literal as it grows, character by character", () => {
  const snippet = 'await itx.chat.sendMessage("Hi there!")';
  expect(distinctPreviews(snippet)).toEqual([
    null, // no preview until the opening quote has streamed
    "",
    "H",
    "Hi",
    "Hi ",
    "Hi t",
    "Hi th",
    "Hi the",
    "Hi ther",
    "Hi there",
    "Hi there!", // the closing `")` doesn't extend it further
  ]);
});

test("full realistic snippet: fence + wrapper + Promise.all progress message", () => {
  const snippet = [
    "```js",
    "async (itx) => {",
    "  const [, inbox] = await Promise.all([",
    '    itx.chat.sendMessage("Checking your email now..."),',
    '    itx.integrations.google["jonas"].gmail.request({ path: "/users/me/messages" }),',
    "  ]);",
    "  return inbox;",
    "}",
    "```",
  ].join("\n");
  expectPreviewOverEveryPrefix(snippet, "Checking your email now...");
});

test("bare await Promise.all([ without assignment", () => {
  const snippet = 'await Promise.all([itx.chat.sendMessage("Working on it"), slowThing()]);';
  expectPreviewOverEveryPrefix(snippet, "Working on it");
});

test("wrapper opener and leading comments are stripped", () => {
  const snippet = [
    "async (itx) => {",
    "  // tell the user first",
    "  /* then do the work */",
    '  await itx.chat.sendMessage("On it!");',
    "  return itx.integrations.list();",
    "}",
  ].join("\n");
  expectPreviewOverEveryPrefix(snippet, "On it!");
});

test("single-quoted and backtick literals work too", () => {
  expectPreviewOverEveryPrefix("await itx.chat.sendMessage('Single quoted')", "Single quoted");
  expectPreviewOverEveryPrefix(
    "await itx.chat.sendMessage(`Backtick message`)",
    "Backtick message",
  );
});

test("second options argument keeps the preview", () => {
  const snippet = 'await itx.chat.sendMessage("hello", { whatever: 123 })';
  expectPreviewOverEveryPrefix(snippet, "hello");
  // Mid-stream, options still being generated:
  expect(extractStreamingSendMessagePreview('itx.chat.sendMessage("hello", { wha')).toBe("hello");
});

test("escaped quotes and standard escapes read clean", () => {
  const snippet = 'await itx.chat.sendMessage("He said \\"hi\\" — line one\\nline two \\\\ done")';
  expectPreviewOverEveryPrefix(snippet, 'He said "hi" — line one\nline two \\ done');
});

test("a dangling backslash mid-stream holds the preview just before it", () => {
  expect(extractStreamingSendMessagePreview('itx.chat.sendMessage("He said \\')).toBe("He said ");
});

test("unicode escapes decode when complete and hold while partial", () => {
  expectPreviewOverEveryPrefix('itx.chat.sendMessage("cat: \\u{1F600}!")', "cat: 😀!");
  expect(extractStreamingSendMessagePreview('itx.chat.sendMessage("cat: \\u{1F6')).toBe("cat: ");
  expectPreviewOverEveryPrefix('itx.chat.sendMessage("A\\u0042C")', "ABC");
});

test("backtick interpolation bails; a lone $ at end of input is held back", () => {
  expect(extractStreamingSendMessagePreview("itx.chat.sendMessage(`hi ${name}`)")).toBe(null);
  expect(extractStreamingSendMessagePreview("itx.chat.sendMessage(`hi ${")).toBe(null);
  // "$" could still become "${" — held back until the next character decides:
  expect(extractStreamingSendMessagePreview("itx.chat.sendMessage(`costs $")).toBe("costs ");
  expectPreviewOverEveryPrefix("itx.chat.sendMessage(`costs $5`)", "costs $5");
});

test("a later token can invalidate an already-showing preview: appear, then vanish", () => {
  // Any preview of an unclosed literal can be invalidated by what streams in
  // next — bail-to-null is deliberate (better a briefly-shown bubble that
  // honestly disappears than previewing a message we can't know).
  expect(distinctPreviews('itx.chat.sendMessage("hi" + name)')).toEqual([
    null,
    "",
    "h",
    "hi", // literal closed; trailing whitespace at end of input still looks well-formed
    null, // the `+` reveals the literal wasn't the whole message — bubble disappears
  ]);
  expect(distinctPreviews("itx.chat.sendMessage(`hi ${name}`)")).toEqual([
    null,
    "",
    "h",
    "hi",
    "hi ", // the lone `$` is held back — this stays "hi " until the next character decides
    null, // `${` streams in: interpolation, value unknowable — bubble disappears
  ]);
});

test("legacy object form gets no preview at any prefix", () => {
  const snippet = 'await itx.chat.sendMessage({ message: "Checking your email now..." })';
  for (let length = 0; length <= snippet.length; length++) {
    expect(extractStreamingSendMessagePreview(snippet.slice(0, length))).toBe(null);
  }
});

test("only the FIRST statement is previewed", () => {
  expect(
    extractStreamingSendMessagePreview('const x = 1;\nawait itx.chat.sendMessage("later")'),
  ).toBe(null);
  expect(
    extractStreamingSendMessagePreview(
      'async (itx) => {\n  await itx.integrations.list();\n  await itx.chat.sendMessage("later")',
    ),
  ).toBe(null);
  // ...including inside Promise.all: only the first entry counts.
  expect(
    extractStreamingSendMessagePreview(
      'await Promise.all([slowThing(), itx.chat.sendMessage("second entry")])',
    ),
  ).toBe(null);
});

test("unrecognized snippets bail", () => {
  expect(extractStreamingSendMessagePreview("")).toBe(null);
  expect(extractStreamingSendMessagePreview("const inbox = await itx.integrations.list()")).toBe(
    null,
  );
  expect(extractStreamingSendMessagePreview("Sure! Let me check your email for you.")).toBe(null);
  // Unclosed opening paren but no string literal yet:
  expect(extractStreamingSendMessagePreview("await itx.chat.sendMessage(")).toBe(null);
  // Concatenation means the literal isn't the whole message:
  expect(extractStreamingSendMessagePreview('itx.chat.sendMessage("hi" + name)')).toBe(null);
  // A raw newline inside a normal string literal is a syntax error:
  expect(extractStreamingSendMessagePreview('itx.chat.sendMessage("hi\nthere')).toBe(null);
  // Comment still streaming — can't see past it yet:
  expect(extractStreamingSendMessagePreview("/* thinking about")).toBe(null);
});

test("later statements never extend a closed preview", () => {
  const closed = 'async (itx) => {\n  await itx.chat.sendMessage("done!");\n';
  const expected = "done!";
  expect(extractStreamingSendMessagePreview(closed)).toBe(expected);
  expect(
    extractStreamingSendMessagePreview(closed + '  await itx.chat.sendMessage("another");\n}'),
  ).toBe(expected);
});

test("empty message previews as empty string once the quote opens", () => {
  expect(extractStreamingSendMessagePreview('itx.chat.sendMessage("')).toBe("");
  expect(extractStreamingSendMessagePreview('itx.chat.sendMessage("")')).toBe("");
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Simulates token-by-token streaming: for every prefix of the snippet the
 * preview must be null or a leading slice of the final message, must never
 * revert to null once it appears (these are all well-formed snippets), and
 * the full snippet must yield exactly the final message.
 */
function expectPreviewOverEveryPrefix(snippet: string, finalMessage: string) {
  let seenPreview = false;
  for (let length = 0; length <= snippet.length; length++) {
    const prefix = snippet.slice(0, length);
    const preview = extractStreamingSendMessagePreview(prefix);
    if (preview === null) {
      expect({ prefix, seenPreview }).toMatchObject({ seenPreview: false });
      continue;
    }
    seenPreview = true;
    expect({ prefix, preview, isLeadingSlice: finalMessage.startsWith(preview) }).toMatchObject({
      isLeadingSlice: true,
    });
  }
  expect(extractStreamingSendMessagePreview(snippet)).toBe(finalMessage);
}

/** The ordered distinct previews seen while streaming the snippet character by character. */
function distinctPreviews(snippet: string): (string | null)[] {
  const seen: (string | null)[] = [];
  for (let length = 0; length <= snippet.length; length++) {
    const preview = extractStreamingSendMessagePreview(snippet.slice(0, length));
    if (seen.length === 0 || seen.at(-1) !== preview) seen.push(preview);
  }
  return seen;
}
