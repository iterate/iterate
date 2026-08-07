import { expect, test } from "vitest";
import { markdownToPlainText } from "./markdown-plain-text.ts";

// One table, input → expected. The guiding rule: unwrap what certainly reads
// better without markers, leave anything ambiguous alone.
const cases: Array<[name: string, input: string, expected: string]> = [
  [
    "the field-report case",
    "The capital of Germany is **Berlin**",
    "The capital of Germany is Berlin",
  ],
  ["italics", "That was *not* the plan", "That was not the plan"],
  ["underscore emphasis", "a _gentle_ nudge", "a gentle nudge"],
  ["snake_case survives", "renamed to push_token_secret_path", "renamed to push_token_secret_path"],
  ["bold-italic nesting", "***very*** important", "very important"],
  ["strikethrough", "~~wrong~~ right", "wrong right"],
  ["inline code", "run `pnpm test` locally", "run pnpm test locally"],
  [
    "links keep their text",
    "see [the docs](https://docs.iterate.com/x) for more",
    "see the docs for more",
  ],
  ["images become alt text", "here: ![the chart](https://x.test/c.png)", "here: the chart"],
  ["headings drop their hashes", "## Deploy status\nAll green.", "Deploy status\n\nAll green."],
  ["blockquotes drop their rail", "> previously\nnow", "previously\nnow"],
  ["star bullets normalize to hyphens", "* one\n* two", "- one\n- two"],
  ["hyphen bullets untouched", "- one\n- two", "- one\n- two"],
  ["numbered lists untouched", "1. first\n2. second", "1. first\n2. second"],
  [
    "code fences unwrap",
    "the fix:\n```ts\nconst x = 1;\n```\ndone",
    "the fix:\n\nconst x = 1;\n\ndone",
  ],
  // The bugbot cases (PR #2433), settled by real CommonMark semantics: the
  // plain text matches what a renderer would SHOW. Standalone `__init__` is
  // strong emphasis per the spec (a renderer bolds it → flattens to init);
  // intraword underscores and anything in code spans are literal.
  ["markers inside code spans are content", "try `a *= 2` or `__all__`", "try a *= 2 or __all__"],
  [
    "standalone dunder is strong emphasis, like any renderer shows it",
    "call __init__",
    "call init",
  ],
  ["intraword dunders stay", "the foo__bar__baz convention", "the foo__bar__baz convention"],
  // Intraword * IS emphasis per CommonMark (a‹em›b‹/em›c renders as abc).
  ["intraword star emphasis flattens", "a*b*c", "abc"],
  ["intraword underscore stays", "a_b_c", "a_b_c"],
  ["horizontal rules vanish", "before\n\n---\n\nafter", "before\n\nafter"],
  ["multiplication is not emphasis", "3 * 4 * 5 = 60", "3 * 4 * 5 = 60"],
  ["plain text is untouched", "No formatting here.", "No formatting here."],
];

test.each(cases)("markdownToPlainText: %s", (_name, input, expected) => {
  expect(markdownToPlainText(input)).toBe(expected);
});
