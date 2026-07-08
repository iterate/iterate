// The agent feed pre-parses a *streaming* code snippet: when the first real
// statement is `itx.chat.sendMessage("...` (possibly still unclosed), the
// partial string literal renders as a live chat-message preview —
// `{ message, literalClosed }`, where `literalClosed` flips true once the
// closing quote streams in (the feed hides the code block until then). These
// tests simulate token-by-token growth by extracting over successive prefixes
// of a full snippet — helpers at the bottom.

import { expect, test } from "vitest";
import { extractStreamingSendMessagePreview } from "./streaming-send-message-preview.ts";

test("streams the leading sendMessage literal as it grows, character by character", () => {
  const snippet = 'await itx.chat.sendMessage("Hi there!")';
  expect(distinctPreviews(snippet)).toEqual([
    null, // no preview until the opening quote has streamed
    { message: "", literalClosed: false },
    { message: "H", literalClosed: false },
    { message: "Hi", literalClosed: false },
    { message: "Hi ", literalClosed: false },
    { message: "Hi t", literalClosed: false },
    { message: "Hi th", literalClosed: false },
    { message: "Hi the", literalClosed: false },
    { message: "Hi ther", literalClosed: false },
    { message: "Hi there", literalClosed: false },
    { message: "Hi there!", literalClosed: false },
    { message: "Hi there!", literalClosed: true }, // the closing quote flips literalClosed
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
  // Mid-stream, options still being generated — the literal itself is closed:
  expect(extractStreamingSendMessagePreview('itx.chat.sendMessage("hello", { wha')).toEqual({
    message: "hello",
    literalClosed: true,
  });
});

test("escaped quotes and standard escapes read clean", () => {
  const snippet = 'await itx.chat.sendMessage("He said \\"hi\\" — line one\\nline two \\\\ done")';
  expectPreviewOverEveryPrefix(snippet, 'He said "hi" — line one\nline two \\ done');
});

test("a dangling backslash mid-stream holds the preview just before it", () => {
  expect(extractStreamingSendMessagePreview('itx.chat.sendMessage("He said \\')).toEqual({
    message: "He said ",
    literalClosed: false,
  });
});

test("unicode escapes decode when complete and hold while partial", () => {
  expectPreviewOverEveryPrefix('itx.chat.sendMessage("cat: \\u{1F600}!")', "cat: 😀!");
  expect(extractStreamingSendMessagePreview('itx.chat.sendMessage("cat: \\u{1F6')).toEqual({
    message: "cat: ",
    literalClosed: false,
  });
  expectPreviewOverEveryPrefix('itx.chat.sendMessage("A\\u0042C")', "ABC");
});

test("backtick interpolation bails; a lone $ at end of input is held back", () => {
  expect(extractStreamingSendMessagePreview("itx.chat.sendMessage(`hi ${name}`)")).toBe(null);
  expect(extractStreamingSendMessagePreview("itx.chat.sendMessage(`hi ${")).toBe(null);
  // "$" could still become "${" — held back until the next character decides:
  expect(extractStreamingSendMessagePreview("itx.chat.sendMessage(`costs $")).toEqual({
    message: "costs ",
    literalClosed: false,
  });
  expectPreviewOverEveryPrefix("itx.chat.sendMessage(`costs $5`)", "costs $5");
});

test("a later token can invalidate an already-showing preview: appear, then vanish", () => {
  // Any preview of an unclosed literal can be invalidated by what streams in
  // next — bail-to-null is deliberate (better a briefly-shown bubble that
  // honestly disappears than previewing a message we can't know).
  expect(distinctPreviews('itx.chat.sendMessage("hi" + name)')).toEqual([
    null,
    { message: "", literalClosed: false },
    { message: "h", literalClosed: false },
    { message: "hi", literalClosed: false },
    // literal closed; trailing whitespace at end of input still looks well-formed
    { message: "hi", literalClosed: true },
    null, // the `+` reveals the literal wasn't the whole message — bubble disappears
  ]);
  expect(distinctPreviews("itx.chat.sendMessage(`hi ${name}`)")).toEqual([
    null,
    { message: "", literalClosed: false },
    { message: "h", literalClosed: false },
    { message: "hi", literalClosed: false },
    // the lone `$` is held back — this stays "hi " until the next character decides
    { message: "hi ", literalClosed: false },
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
  const expected = { message: "done!", literalClosed: true };
  expect(extractStreamingSendMessagePreview(closed)).toEqual(expected);
  expect(
    extractStreamingSendMessagePreview(closed + '  await itx.chat.sendMessage("another");\n}'),
  ).toEqual(expected);
});

test("empty message previews as empty string once the quote opens", () => {
  expect(extractStreamingSendMessagePreview('itx.chat.sendMessage("')).toEqual({
    message: "",
    literalClosed: false,
  });
  expect(extractStreamingSendMessagePreview('itx.chat.sendMessage("")')).toEqual({
    message: "",
    literalClosed: true,
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Simulates token-by-token streaming: for every prefix of the snippet the
 * preview must be null or a leading slice of the final message, must never
 * revert to null once it appears (these are all well-formed snippets), and
 * once the literal closes it must stay closed at exactly the final message.
 * The full snippet must yield the final message, closed.
 */
function expectPreviewOverEveryPrefix(snippet: string, finalMessage: string) {
  let seenPreview = false;
  let seenClosed = false;
  for (let length = 0; length <= snippet.length; length++) {
    const prefix = snippet.slice(0, length);
    const preview = extractStreamingSendMessagePreview(prefix);
    if (preview === null) {
      expect({ prefix, seenPreview }).toMatchObject({ seenPreview: false });
      continue;
    }
    seenPreview = true;
    const isLeadingSlice = finalMessage.startsWith(preview.message);
    expect({ prefix, preview, isLeadingSlice }).toMatchObject({ isLeadingSlice: true });
    if (seenClosed || preview.literalClosed) {
      expect({ prefix, preview }).toMatchObject({
        preview: { message: finalMessage, literalClosed: true },
      });
      seenClosed = true;
    }
  }
  expect(extractStreamingSendMessagePreview(snippet)).toEqual({
    message: finalMessage,
    literalClosed: true,
  });
}

/** The ordered distinct previews seen while streaming the snippet character by character. */
function distinctPreviews(snippet: string) {
  const seen: ({ message: string; literalClosed: boolean } | null)[] = [];
  for (let length = 0; length <= snippet.length; length++) {
    const preview = extractStreamingSendMessagePreview(snippet.slice(0, length));
    if (seen.length === 0 || JSON.stringify(seen.at(-1)) !== JSON.stringify(preview)) {
      seen.push(preview);
    }
  }
  return seen;
}
