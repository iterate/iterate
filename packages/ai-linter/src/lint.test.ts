import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  checkRunOutput,
  globToRegExp,
  isRuleFile,
  isSuppressed,
  keepDiagnostics,
  lintTask,
  modelText,
  numberedPatch,
  parseDirective,
  parsePatch,
  parseResult,
  parseRule,
  problemLines,
  reviewBody,
  reviewComments,
  ruleApplies,
  type Diagnostic,
  type Finding,
  type JevRule,
  type Problem,
  type Rule,
} from "./lint.ts";

const RULE_FILE = `---
id: typescript/explain-type-cast
severity: error
files:
  [
    "**/*.{ts,tsx,mts,cts}",
    "!**/*.{test,spec}.{js,ts}",
    "!**/{__tests__,e2e}/**",
  ]
---

# Explain type casts

Every type cast must have a nearby explanation.
`;

test("a rule file: id, severity, the flow list of globs, the prose; no engine is the LLM", () => {
  expect(parseRule("rules/typescript/explain-type-cast.md", RULE_FILE)).toEqual({
    id: "typescript/explain-type-cast",
    severity: "error",
    engine: "llm",
    suggestions: "allowed",
    files: ["**/*.{ts,tsx,mts,cts}", "!**/*.{test,spec}.{js,ts}", "!**/{__tests__,e2e}/**"],
    body: "# Explain type casts\n\nEvery type cast must have a nearby explanation.",
  });
});

test("a rule file with a block list and suggestions forbidden", () => {
  const rule = parseRule(
    "r.md",
    "---\nid: a/b\nseverity: warning\nfiles:\n  - '**/*.md'\nsuggestions: forbidden\n---\nbody\n",
  );
  expect([rule.files, rule.suggestions, rule.severity]).toEqual([
    ["**/*.md"],
    "forbidden",
    "warning",
  ]);
  expect(() => parseRule("r.md", "no frontmatter")).toThrow(/no frontmatter/);
  expect(() => parseRule("r.md", '---\nid: x\nseverity: loud\nfiles: ["a"]\n---\n')).toThrow(
    /severity/,
  );
});

test("globs: ** spans directories, * and ? stay in one segment, braces alternate", () => {
  const cases: [string, string, boolean][] = [
    ["**/*.ts", "a.ts", true],
    ["**/*.ts", "core/os/src/a.ts", true],
    ["**/*.ts", "a.tsx", false],
    ["*.ts", "src/a.ts", false],
    ["**/*.{ts,tsx}", "x/y.tsx", true],
    ["**/{__tests__,e2e}/**", "core/os/e2e/a.ts", true],
    ["**/{__tests__,e2e}/**", "core/os/e2e-helpers/a.ts", false],
    ["packages/ui/src/hooks/use-mobile.ts", "packages/ui/src/hooks/use-mobile.ts", true],
    ["a?.md", "ab.md", true],
    ["a?.md", "a/.md", false],
    ["**/*{test-helper,fixture}*.{ts,tsx}", "src/my-fixture-data.ts", true],
  ];
  for (const [glob, path, expected] of cases)
    expect(globToRegExp(glob).test(path), `${glob} vs ${path}`).toBe(expected);
});

test("a rule applies to a path a positive glob matches and no ! glob does", () => {
  const rule = parseRule("r.md", RULE_FILE);
  expect(ruleApplies(rule, "core/os/src/worker.ts")).toBe(true);
  expect(ruleApplies(rule, "core/os/src/worker.test.ts")).toBe(false);
  expect(ruleApplies(rule, "core/os/e2e/client.ts")).toBe(false);
  expect(ruleApplies(rule, "README.md")).toBe(false);
});

const PATCH = [
  "@@ -10,4 +10,5 @@ export function f() {",
  " const a = 1;",
  "-const b = a as number;",
  "+const b = a as unknown as string;",
  "+const c = 3;",
  " return b;",
  "@@ -40,2 +41,2 @@",
  " x();",
  "+y();",
  "\\ No newline at end of file",
].join("\n");

test("a patch is numbered on the RIGHT side; removed lines take no number", () => {
  const lines = parsePatch(PATCH).filter((line) => line.kind !== "hunk");
  expect(lines).toEqual([
    { kind: "context", line: 10, text: "const a = 1;" },
    { kind: "removed", text: "const b = a as number;" },
    { kind: "added", line: 11, text: "const b = a as unknown as string;" },
    { kind: "added", line: 12, text: "const c = 3;" },
    { kind: "context", line: 13, text: "return b;" },
    { kind: "context", line: 41, text: "x();" },
    { kind: "added", line: 42, text: "y();" },
  ]);
  expect(numberedPatch(PATCH)).toMatch(/^ {3}11 \+ const b = a as unknown as string;$/m);
  expect(numberedPatch(PATCH)).toMatch(/^ {6}- const b = a as number;$/m);
});

test("directives: Oxlint's grammar, a disable needs a reason", () => {
  expect(
    parseDirective("// iterate-lint-disable-next-line a/b, c/d -- the API is untyped"),
  ).toEqual({
    kind: "disable-next-line",
    rules: ["a/b", "c/d"],
    reason: "the API is untyped",
  });
  expect(parseDirective("/* iterate-lint-disable -- generated */")).toEqual({
    kind: "disable",
    rules: [],
    reason: "generated",
  });
  expect(parseDirective("# iterate-lint-enable a/b")).toEqual({
    kind: "enable",
    rules: ["a/b"],
    reason: "",
  });
  expect(parseDirective("// iterate-lint-disable-line a/b")).toBe(null); // no reason
  expect(parseDirective("// iterate-lint-disabled a/b -- x")).toBe(null);
  expect(parseDirective("const x = 1;")).toBe(null);
});

test("suppression: the line, the next line, and disabled regions", () => {
  const source = [
    "const a = x as A; // iterate-lint-disable-line t/cast -- x is A by construction", // 1
    "// iterate-lint-disable-next-line t/cast -- the SDK's type is wrong", // 2
    "const b = x as B;", // 3
    "const c = x as C;", // 4
    "/* iterate-lint-disable t/cast -- generated below */", // 5
    "const d = x as D;", // 6
    "// iterate-lint-enable t/cast", // 7
    "const e = x as E;", // 8
    "// iterate-lint-disable -- everything off", // 9
    "const f = x as F;", // 10
  ].join("\n");
  const at = (line: number, rule = "t/cast") => isSuppressed(source, line, rule);
  expect([1, 3, 4, 6, 8, 10].map((line) => at(line))).toEqual([
    true,
    true,
    false,
    true,
    false,
    true,
  ]);
  expect(at(3, "other/rule")).toBe(false);
  expect(at(10, "other/rule")).toBe(true);
});

const RULES: Rule[] = [
  {
    id: "t/cast",
    severity: "error",
    engine: "llm",
    suggestions: "allowed",
    files: ["**/*.ts"],
    body: "",
  },
  {
    id: "t/words",
    severity: "warning",
    engine: "llm",
    suggestions: "forbidden",
    files: ["**/*.ts"],
    body: "",
  },
];

test("only diagnostics on added RIGHT lines of an applicable rule survive, once, unsuppressed", () => {
  const files = [{ path: "src/a.ts", patch: PATCH, rules: ["t/cast", "t/words"] }];
  const sources = new Map([
    ["src/a.ts", "\n".repeat(41) + "y(); // iterate-lint-disable-line t/cast -- fine\n"],
  ]);
  const { kept, dropped } = keepDiagnostics({
    files,
    rules: RULES,
    sources,
    diagnostics: [
      diagnostic({}),
      diagnostic({ key: "t/cast:src/a.ts:b" }), // the same key again
      diagnostic({ startLine: 10, endLine: 10, key: "context" }), // a context line only
      diagnostic({ startLine: 10, endLine: 12, key: "span", suggestion: "x" }), // spans context + added
      diagnostic({ startLine: 5, endLine: 5, key: "outside" }), // not in the diff
      diagnostic({ rule: "t/unknown", key: "unknown" }),
      diagnostic({ path: "src/other.ts", key: "other" }),
      diagnostic({ startLine: 42, endLine: 42, key: "suppressed" }),
      diagnostic({ startLine: 41, endLine: 42, key: "suppressed-later-in-span" }),
      diagnostic({ rule: "t/words", startLine: 12, endLine: 12, key: "words", suggestion: "y" }),
    ],
  });
  expect(kept.map((d) => [d.key, d.suggestion])).toEqual([
    ["t/cast:src/a.ts:b", "const b = a;"],
    ["span", null], // a suggestion may only replace added lines
    ["words", null], // the rule forbids suggestions
  ]);
  expect(dropped.map((d) => d.reason)).toEqual([
    "a duplicate",
    "not on a line the pull request added",
    "not on a line the pull request added",
    "the rule does not apply to that file",
    "the rule does not apply to that file",
    "suppressed",
    "suppressed",
  ]);
});

test("the model's JSON is checked field by field", () => {
  const good = diagnostic({});
  const result = parseResult(
    JSON.stringify({
      summary: "ok",
      diagnostics: [good, { ...good, startLine: "3" }, { ...good, endLine: 1 }, null],
    }),
  );
  expect(result).toEqual({ summary: "ok", diagnostics: [good] });
  expect(() => parseResult("not json")).toThrow();
});

test("inline comments: one per diagnostic, multi-line spans, a fence longer than the content's backticks", () => {
  const [single, multi] = reviewComments([
    diagnostic({ suggestion: "const s = ```x```;" }),
    diagnostic({ startLine: 11, endLine: 12, suggestion: null }),
  ]);
  expect({
    path: single.path,
    line: single.line,
    side: single.side,
    start_line: "start_line" in single,
  }).toEqual({ path: "src/a.ts", line: 11, side: "RIGHT", start_line: false });
  expect(single.body).toMatch(
    /^\*\*\[t\/cast\]\*\* unexplained cast\n\n````suggestion\nconst s = ```x```;\n````$/,
  );
  expect([multi.start_line, multi.line, multi.body]).toEqual([
    11,
    12,
    "**[t/cast]** unexplained cast",
  ]);
});

test("the model's text: a Responses API output item, output_text, or Workers AI's response", () => {
  const responses = {
    output: [
      { type: "reasoning", summary: [] },
      { type: "message", content: [{ type: "output_text", text: '{"a":1}' }] },
    ],
  };
  expect(modelText(responses)).toBe('{"a":1}');
  expect(modelText({ output_text: "x" })).toBe("x");
  expect(modelText({ response: "y" })).toBe("y");
  expect(() => modelText({ output: [] })).toThrow(/no text/);
});

const JEV_RULE_FILE = `---
id: t/words
severity: warning
files: ["**/*.ts", "!**/*.gen.ts"]
suggestions: forbidden
engine: jev
select: { line: '\\b(lane|door)s?\\b' }
window: [2, 1] # lines before, after the unit
question:
  instructions: |
    Judge the word "{match}" on the line marked ">".

    It violates the rule when it is a metaphor.
  "true": "A metaphor."
  "false": "Literal."
flag: 0.6 # p >= flag: a diagnostic with message
pass: 0.3
message: "\`{match}\` is a metaphor."
---

# Words

Prose for the LLM.
`;

test("a jev rule: its selector, window, question, band and message", () => {
  expect(parseRule("rules/t/words.md", JEV_RULE_FILE)).toEqual({
    id: "t/words",
    severity: "warning",
    engine: "jev",
    suggestions: "forbidden",
    files: ["**/*.ts", "!**/*.gen.ts"],
    body: "# Words\n\nProse for the LLM.",
    select: { kind: "line", pattern: "\\b(lane|door)s?\\b" },
    window: { before: 2, after: 1 },
    question: {
      // a block scalar's final newline is not part of the question
      instructions:
        'Judge the word "{match}" on the line marked ">".\n\nIt violates the rule when it is a metaphor.',
      true: "A metaphor.",
      false: "Literal.",
    },
    flag: 0.6,
    pass: 0.3,
    message: "`{match}` is a metaphor.",
  });
});

test("a jev rule's selectors, and a band that is only a threshold", () => {
  const withSelect = (select: string, extra = "pass: 0.3\n") =>
    JEV_RULE_FILE.replace(/^select: .*$/m, `select: ${select}`).replace(/^pass: .*\n/m, extra);
  for (const kind of ["comment", "cast", "conditional", "shape"] as const) {
    const rule = parseRule("r.md", withSelect(kind)) as JevRule;
    expect(rule).toMatchObject({ select: { kind } });
  }
  // no pass: every p below flag passes, nothing is escalated
  expect(parseRule("r.md", withSelect("cast", ""))).toMatchObject({ pass: 0.6 });
  expect(() => parseRule("r.md", withSelect("shape-check"))).toThrow(/r\.md: select must be/);
  expect(() => parseRule("r.md", withSelect("{ line: '(' }"))).toThrow(
    /r\.md: select's line is not a regular expression/,
  );
  expect(() => parseRule("r.md", withSelect("cast", "pass: 0.7\n"))).toThrow(
    /pass must be a number from 0 to flag/,
  );
  expect(() => parseRule("r.md", JEV_RULE_FILE.replace("flag: 0.6", "flag: 1.5"))).toThrow(
    /flag must be a number above 0/,
  );
  expect(() => parseRule("r.md", JEV_RULE_FILE.replace("window: [2, 1]", "window: [2]"))).toThrow(
    /window must be/,
  );
  expect(() => parseRule("r.md", JEV_RULE_FILE.replace(/^message: .*$/m, ""))).toThrow(
    /message must be/,
  );
  expect(() => parseRule("r.md", JEV_RULE_FILE.replace('  "false": "Literal."\n', ""))).toThrow(
    /question needs/,
  );
  expect(() => parseRule("r.md", JEV_RULE_FILE.replace("engine: jev", "engine: regex"))).toThrow(
    /engine must be llm or jev/,
  );
  // the jev fields on an LLM rule are a mistake, not something to ignore
  expect(() => parseRule("r.md", JEV_RULE_FILE.replace("engine: jev", "engine: llm"))).toThrow(
    /question, flag, pass and message need engine: jev/,
  );
  expect(() => parseRule("r.md", "---\nid: [unclosed\n---\n")).toThrow(
    /r\.md: the frontmatter is not YAML/,
  );
});

const FIXTURE_RULES = join(import.meta.dirname, "fixtures/rules");
const fixtureRules = readdirSync(FIXTURE_RULES, { recursive: true, encoding: "utf8" })
  .filter((path) => path.endsWith(".md"))
  .sort()
  .map((path) => parseRule(path, readFileSync(join(FIXTURE_RULES, path), "utf8")));

test("the measured rules parse: five on Jev with the chosen band, the repeated-explanations rule on the LLM", () => {
  expect(
    fixtureRules.map((rule) =>
      rule.engine === "jev"
        ? [rule.id, rule.select.kind, rule.window.before, rule.window.after, rule.flag, rule.pass]
        : [rule.id, rule.engine],
    ),
  ).toEqual([
    ["comments/no-narrating-comments", "comment", 0, 3, 0.65, 0.25],
    ["comments/no-repeated-explanations", "llm"],
    ["structure/prefer-clear-conditionals", "conditional", 4, 4, 0.7, 0.6],
    ["structure/validate-unknown-shapes", "shape", 3, 2, 0.75, 0.75],
    ["terminology/no-metaphorical-lane-door-seam", "line", 2, 2, 0.6, 0.3],
    ["typescript/explain-type-cast", "cast", 15, 3, 0.95, 0.7],
  ]);
  // generated files are nobody's to fix by hand
  for (const rule of fixtureRules) {
    expect(ruleApplies(rule, "core/os/src/routeTree.gen.ts"), rule.id).toBe(false);
    expect(ruleApplies(rule, "core/os/src/router.ts"), rule.id).toBe(true);
  }
});

test("an LLM rule may select what the LLM reads: its units with a window around each, both or neither", () => {
  const llmRule = (extra: string) =>
    parseRule("r.md", `---\nid: c/r\nseverity: error\nfiles: ["**/*.ts"]\n${extra}---\nprose\n`);
  expect(llmRule("select: comment\nwindow: [3, 5]\n")).toEqual({
    id: "c/r",
    severity: "error",
    suggestions: "allowed",
    files: ["**/*.ts"],
    body: "prose",
    engine: "llm",
    select: { kind: "comment" },
    window: { before: 3, after: 5 },
  });
  expect(llmRule("")).not.toHaveProperty("select");
  expect(() => llmRule("select: comment\n")).toThrow(
    /window must be \[lines before, lines after\]/,
  );
  expect(() => llmRule("window: [1, 1]\n")).toThrow(/select must be comment/);
  expect(() => llmRule("select: comment\nwindow: [1, 1]\nflag: 0.5\n")).toThrow(/need engine: jev/);
});

test("the LLM is told when a file is shown as excerpts", () => {
  const rule = parseRule("r.md", "---\nid: c/r\nseverity: error\nfiles: ['**/*.ts']\n---\nprose\n");
  const patch = "@@ -1,2 +1,2 @@\n+// a comment\n code();";
  expect(lintTask([rule], [{ path: "a.ts", patch, rules: ["c/r"], excerpts: true }])).toMatch(
    /### a.ts\nrules: c\/r\nshown: excerpts, the lines the rules select with the lines around them; the rest of the file is not shown\n\n/,
  );
  expect(lintTask([rule], [{ path: "a.ts", patch, rules: ["c/r"] }])).not.toMatch(/shown:/);
});

test("rules/README.md documents the format and is not a rule", () => {
  expect(isRuleFile("rules/README.md")).toBe(false);
  expect(isRuleFile("rules/comments/no-narrating-comments.md")).toBe(true);
  expect(isRuleFile("rules/notes.txt")).toBe(false);
});

test("the Check Run names the engine that decided each finding, with Jev's p and the message", () => {
  const finding = (overrides: Partial<Finding>): Finding => ({
    ...diagnostic({ suggestion: null }),
    decidedBy: { engine: "llm", p: null },
    ...overrides,
  });
  const output = checkRunOutput({
    summary: "The added code follows the rules.",
    findings: [
      finding({
        rule: "t/words",
        path: "src/a.ts",
        startLine: 3,
        endLine: 3,
        message: "A lane.",
        decidedBy: { engine: "jev", p: 0.974 },
      }),
      finding({
        rule: "t/cast",
        path: "src/b.ts",
        startLine: 9,
        endLine: 10,
        message: "No reason.",
        decidedBy: { engine: "llm", p: 0.5 },
      }),
      finding({ rule: "t/lame", path: "src/c.ts", startLine: 1, endLine: 1, message: "Lame." }),
    ],
    jev: {
      units: 41,
      judged: 40,
      inputTokens: 31_234,
      flagged: 1,
      escalated: 2,
      passed: 37,
      failed: 0,
      notJudged: ["1 unit past the first 40"],
    },
    problems: [],
    reviewUrl: "https://github.com/iterate/iterate/pull/1#pullrequestreview-2",
    notReviewed: ["huge.ts"],
    rules: [
      { ...RULES[0], id: "t/cast" },
      { ...RULES[0], id: "t/lame" },
      { ...(parseRule("r.md", JEV_RULE_FILE) as JevRule) },
    ],
    repository: "iterate/iterate",
    baseSha: "abc123",
  });
  expect(output).toEqual({
    conclusion: "neutral",
    title: "3 findings",
    complete: true,
    summary: [
      "The added code follows the rules.",
      [
        "Findings, and what decided each:",
        "- **[t/words]** `src/a.ts:3` (Jev, p 0.97): A lane.",
        "- **[t/cast]** `src/b.ts:9` (the LLM, on a candidate Jev left unsure (p 0.50)): No reason.",
        "- **[t/lame]** `src/c.ts:1` (the LLM): Lame.",
      ].join("\n"),
      "Jev judged 40 of 41 units, one request each (31234 input tokens): 1 flagged, 2 left to the LLM, 37 passed.",
      "Jev did not judge: 1 unit past the first 40",
      "Review: https://github.com/iterate/iterate/pull/1#pullrequestreview-2",
      "Not read by the LLM (too large or no patch): huge.ts",
      "Rules from iterate/iterate@abc123: on Jev t/words; on the LLM t/cast, t/lame.",
    ].join("\n\n"),
  });
});

test("a Check Run with every part run and nothing found succeeds; a limit is not a failure", () => {
  const output = checkRunOutput({
    summary: "Fine.",
    findings: [],
    jev: {
      units: 700,
      judged: 600,
      inputTokens: 1,
      flagged: 0,
      escalated: 0,
      passed: 600,
      failed: 0,
      notJudged: ["100 units past the first 600"],
    },
    problems: [],
    reviewUrl: null,
    notReviewed: ["huge.ts"],
    rules: RULES,
    repository: "iterate/iterate",
    baseSha: "abc123",
  });
  expect([output.conclusion, output.title, output.complete]).toEqual([
    "success",
    "No findings",
    true,
  ]);
});

test("what did not run heads the Check Run, names itself in the title and makes it neutral", () => {
  const jev = {
    units: 30,
    judged: 12,
    inputTokens: 9_000,
    flagged: 1,
    escalated: 0,
    passed: 11,
    failed: 18,
    notJudged: [
      "6 units Jev did not answer in 5 tries (2018: Invalid User Credentials)",
      "12 units not asked, after 12 in a row went unanswered",
    ],
  };
  const problems: Problem[] = [
    {
      stage: "llm",
      error: "5007: No such model openai/no-such-model",
      rules: ["t/lame", "t/cast"],
    },
    { stage: "escalation", error: "5007: No such model openai/no-such-model", units: 2 },
    { stage: "rule", error: "rules/x.md: severity must be error or warning" },
    { stage: "rule", error: "rules/y.md: no frontmatter" },
    {
      stage: "file",
      error: "src/a.ts could not be read, so Jev did not judge it: GitHub GET …: 502",
    },
    { stage: "review", error: "GitHub POST /repos/iterate/iterate/pulls/1/reviews: 500 boom" },
  ];
  expect(problemLines(problems, jev)).toEqual([
    "The LLM's call failed, so t/lame, t/cast did not run: 5007: No such model openai/no-such-model",
    "The LLM's call on the 2 units Jev left unsure failed, so they are undecided: 5007: No such model openai/no-such-model",
    "A rule did not run: rules/x.md: severity must be error or warning",
    "A rule did not run: rules/y.md: no frontmatter",
    "src/a.ts could not be read, so Jev did not judge it: GitHub GET …: 502",
    "The review was not posted, so its findings are only listed here: GitHub POST /repos/iterate/iterate/pulls/1/reviews: 500 boom",
    "Jev did not judge 18 of 30 units: 6 units Jev did not answer in 5 tries (2018: Invalid User Credentials); 12 units not asked, after 12 in a row went unanswered",
  ]);
  const base = {
    summary: "",
    findings: [],
    jev: null,
    problems: [],
    reviewUrl: null,
    notReviewed: [],
    rules: RULES,
    repository: "iterate/iterate",
    baseSha: "abc123",
  };
  const output = checkRunOutput({ ...base, jev, problems });
  expect([output.conclusion, output.complete]).toEqual(["neutral", false]);
  expect(output).toMatchObject({
    title:
      "No findings; incomplete: the LLM failed, unsure units undecided, a rule did not run, a file was not read, the review was not posted, Jev did not judge 18 units",
  });
  expect(output.summary).toMatch(
    /^\*\*Incomplete\.\*\*\n- The LLM's call failed, so t\/lame, t\/cast did not run/,
  );
  const finding: Finding = {
    ...diagnostic({ suggestion: null }),
    decidedBy: { engine: "llm", p: null },
  };
  expect(checkRunOutput({ ...base, findings: [finding] })).toMatchObject({ title: "1 finding" });
});

test("the review says what did not run above the summary", () => {
  const body = reviewBody({
    marker: "<!-- k -->",
    summary: "Summary.",
    diagnostics: [
      diagnostic({ rule: "t/cast", path: "a.ts", startLine: 2, endLine: 2, message: "No reason." }),
    ],
    rules: RULES,
    notReviewed: [],
    problems: ["The LLM's call failed, so t/lame did not run: boom"],
  });
  expect(body).toBe(
    [
      "<!-- k -->",
      "## Iterate GitHub AI linter",
      "1 errors, 0 warnings.",
      "**Incomplete.**\n- The LLM's call failed, so t/lame did not run: boom",
      "Summary.",
      "- **[t/cast]** `a.ts:2` No reason.",
    ].join("\n\n"),
  );
});

/** A diagnostic of t/cast on src/a.ts line 11, with `overrides`. */
function diagnostic(overrides: Partial<Diagnostic>): Diagnostic {
  return {
    rule: "t/cast",
    path: "src/a.ts",
    startLine: 11,
    endLine: 11,
    message: "unexplained cast",
    suggestion: "const b = a;",
    key: "t/cast:src/a.ts:b",
    ...overrides,
  };
}
