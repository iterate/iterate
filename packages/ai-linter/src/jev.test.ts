// iterate-lint-disable terminology/no-metaphorical-lane-door-seam -- the rule's own cases, the words it matches
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  assess,
  confirmedEscalations,
  escalationFiles,
  jevAnswer,
  jevFinding,
  jevRequest,
  selectUnits,
  sourceFile,
  type Candidate,
  type Unit,
} from "./jev.ts";
import { numberedPatch, parseRule, type Diagnostic, type JevRule } from "./lint.ts";

// The Jev lint experiment's labelled cases (2026-09-27), exported
// with the experiment's own TypeScript-AST selectors and question formulations.
type FixtureCase = {
  cid: string;
  rule: string;
  label: 0 | 1;
  p: number;
  path: string;
  text: string;
  added: number[];
  start: number;
  end: number;
  selected: boolean;
  match?: string;
  node?: string;
};
type FixtureRequest = {
  cid: string;
  rule: string;
  path: string;
  firstLine: number;
  lines: string[];
  start: number;
  end: number;
  match?: string;
  node?: string;
  state: string;
  questions: unknown;
};
const fixture: { cases: FixtureCase[]; requests: FixtureRequest[] } = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures/jev-cases.json"), "utf8"),
);
const RULES_DIR = join(import.meta.dirname, "fixtures/rules");
const rules = new Map<string, JevRule>();
for (const path of readdirSync(RULES_DIR, { recursive: true, encoding: "utf8" })) {
  if (!path.endsWith(".md")) continue;
  const rule = parseRule(path, readFileSync(join(RULES_DIR, path), "utf8"));
  if (rule.engine === "jev") rules.set(rule.id, rule);
}

test("the selectors pick every labelled case the experiment's selectors picked, with its match and node", () => {
  const misses: string[] = [];
  for (const c of fixture.cases) {
    const units = selectUnits(ruleOf(c.rule).select, sourceFile(c.path, c.text, c.added));
    const unit = units.find((candidate) => candidate.start === c.start && candidate.end === c.end);
    if (!c.selected) {
      // lane's labelled set also holds plane, controlPlane and seamless, which the rule's word regex skips
      if (unit) misses.push(`${c.cid}: picked, but the rule's regex skips it`);
      continue;
    }
    if (!unit) misses.push(`${c.cid}: not picked`);
    else if (c.match && unit.match !== c.match)
      misses.push(`${c.cid}: match ${unit.match} ≠ ${c.match}`);
    else if (c.node && unit.node !== c.node) misses.push(`${c.cid}: node ${unit.node} ≠ ${c.node}`);
  }
  expect(misses).toEqual([]);
  expect(fixture.cases.length).toBe(398);
});

test("cast: `as T` and `<T>x` on added lines; never `as const`", () => {
  const text = lines(
    "const a = b as number;",
    "const c = <string>d;",
    "const e = [1, 2] as const;",
    "const f = <const>['x'];",
    "const g = h satisfies T;",
    "const i = j!;",
    "const k = l as unknown as M;",
    "const n = o as P;",
  );
  const units = selectUnits({ kind: "cast" }, sourceFile("a.ts", text, [1, 2, 3, 4, 5, 6, 7]));
  expect(units.map((unit) => [unit.start, unit.node])).toEqual([
    [1, "b as number"],
    [2, "<string>d"],
    [7, "l as unknown as M"],
    [7, "l as unknown"],
  ]);
  // JSX only in .tsx, where `<T>x` cannot be written
  const tsx = lines("const a = <div>{b as string}</div>;");
  expect(
    selectUnits({ kind: "cast" }, sourceFile("a.tsx", tsx, [1])).map((unit) => unit.node),
  ).toEqual(["b as string"]);
});

test("a file that does not parse gives no AST candidates", () => {
  const file = sourceFile("a.ts", "const a = (b as number;", [1]);
  expect(selectUnits({ kind: "cast" }, file)).toEqual([]);
  expect(file.parseError() ?? "").toMatch(/./);
  expect(sourceFile("a.ts", "const a = 1;", [1]).parseError()).toBe(null);
  // a comment is text: it is picked whatever the code around it does
  expect(
    selectUnits({ kind: "comment" }, sourceFile("a.ts", "// a comment here\n(", [1])).length,
  ).toBe(1);
});

test("conditional: the outermost ternary and an if with an else, starting on an added line", () => {
  const text = lines(
    "function f(x: number) {", // 1
    "  const a = x > 1 ? 'a' : x > 0 ? 'b' : 'c';", // 2: one chain, one candidate
    "  if (x) {", // 3: an if / else if / else chain is one candidate
    "    g();",
    "  } else if (x < 0) {",
    "    h();",
    "  } else {",
    "    i();",
    "  }", // 9
    "  if (x) g();", // 10: no else
    // iterate-lint-disable-next-line comments/no-narrating-comments -- labels a test input line
    "  const b = x > 1 ? (x > 2 ? 'c' : 'b') : 'a';", // 11: parentheses do not split a nested ternary
    // iterate-lint-disable-next-line comments/no-narrating-comments -- labels a test input line
    "  return x", // 12: starts on a line the pull request did not add
    "    ? 1",
    "    : 2;",
    "}",
  );
  const units = selectUnits(
    { kind: "conditional" },
    sourceFile("a.ts", text, [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14]),
  );
  expect(units.map((unit) => [unit.start, unit.end])).toEqual([
    [2, 2],
    [3, 9],
    [11, 11],
  ]);
});

test("shape: a chain of two or more runtime shape tests, or parsed JSON asserted to a type", () => {
  const text = lines(
    "const a = typeof v === 'object' && v !== null && 'id' in v;", // 1
    "const b = x ?? y ?? z;", // 2: ?? is not a shape test
    "const c = typeof v === 'string' && v.length > 0;", // 3: one shape test
    "const d = JSON.parse(text) as Payload;", // 4
    "const e = (await request.json()) as Payload;", // 5
    "const f = await response.json() as Payload;", // 6
    "const g = Array.isArray(v) || !(v instanceof Map);", // 7
    "const h = (a && b) || c;", // 8
  );
  const units = selectUnits({ kind: "shape" }, sourceFile("a.ts", text, all(text)));
  expect(units.map((unit) => [unit.start, unit.node])).toEqual([
    [1, "typeof v === 'object' && v !== null && 'id' in v"],
    [4, "JSON.parse(text) as Payload"],
    [5, "(await request.json()) as Payload"],
    [6, "await response.json() as Payload"],
    [7, "Array.isArray(v) || !(v instanceof Map)"],
  ]);
});

test("comment: runs of comment lines and trailing comments with an added line; a lint directive alone is not one", () => {
  const text = lines(
    "// iterate-lint-disable-next-line t/x -- a reason", // 1
    "const a = 1;",
    "// Explains why a is one.", // 3
    "// It carries on.", // 4
    "const b = 2; // a trailing comment that is long", // 5
    "/*", // 6
    " * block",
    " */", // 8
    "const c = 3;",
    "// not added", // 10
  );
  const units = selectUnits(
    { kind: "comment" },
    sourceFile("a.ts", text, [1, 2, 3, 4, 5, 6, 7, 8, 9]),
  );
  expect(units.map((unit) => [unit.start, unit.end])).toEqual([
    [3, 4],
    [5, 5],
    [6, 8],
  ]);
  const yaml = lines("# The deploy job.", "deploy:", "  run: x # trailing words here");
  expect(
    selectUnits({ kind: "comment" }, sourceFile("ci.yml", yaml, all(yaml))).map(
      (unit) => unit.start,
    ),
  ).toEqual([1, 3]);
});

test("line: added lines the regex matches, with the whole words it matched", () => {
  const text = lines(
    "const fastLane = 1; // the slow lane",
    "const plane = 2;",
    "const backdoor = 3;",
    "TEST_TELEMETRY_LANE=1",
    "a seamless seam",
    "the door",
  );
  const units = selectUnits(
    ruleOf("terminology/no-metaphorical-lane-door-seam").select,
    sourceFile("a.ts", text, [1, 2, 3, 4, 5]),
  );
  expect(units.map((unit) => [unit.start, unit.match])).toEqual([
    [1, "fastLane, lane"],
    [3, "backdoor"],
    [4, "TEST_TELEMETRY_LANE"],
    [5, "seam"],
  ]);
});

test("each candidate is one Jev request, byte for byte the request the experiment measured", () => {
  expect(fixture.requests.length).toBe(30);
  for (const request of fixture.requests) {
    const text = [...Array<string>(request.firstLine - 1).fill(""), ...request.lines].join("\n");
    const unit: Unit = {
      start: request.start,
      end: request.end,
      match: request.match || null,
      node: request.node || null,
    };
    const built = jevRequest(ruleOf(request.rule), sourceFile(request.path, text, []), unit);
    expect(JSON.stringify(built), request.cid).toBe(
      JSON.stringify({ state: request.state, questions: request.questions }),
    );
  }
});

test("Jev's answer: p for the one question, and the tokens it read", () => {
  // what the project's Workers AI binding answers (prd, 2026-09-27)
  const binding = {
    state: "Completed",
    result: {
      model: "jev-1.13.0",
      answers: { v: { type: "noul", noul: 0.95 } },
      usage: { input_tokens: 340, output_tokens: 20 },
    },
    gatewayMetadata: { keySource: "Unified" },
  };
  expect(jevAnswer(binding)).toEqual({ p: 0.95, inputTokens: 340 });
  expect(() => jevAnswer({ state: "Queued" })).toThrow(/Jev answered no p/);
  expect(
    jevAnswer({ answers: { v: { type: "noul", noul: 0.83 } }, usage: { input_tokens: 812 } }),
  ).toEqual({
    p: 0.83,
    inputTokens: 812,
  });
  expect(jevAnswer({ answers: { v: { type: "noul", noul: 0 } } })).toEqual({
    p: 0,
    inputTokens: 0,
  });
  expect(() => jevAnswer({ answers: {} })).toThrow(/Jev answered no p/);
  expect(() => jevAnswer({ answers: { v: { type: "noul", noul: 1.5 } } })).toThrow(
    /Jev answered no p/,
  );
  expect(() => jevAnswer(null)).toThrow(/Jev answered no p/);
});

test("the band: flag at p ≥ flag, pass below pass, the LLM in between", () => {
  const band = { flag: 0.65, pass: 0.25 };
  expect([0.9, 0.65, 0.649, 0.25, 0.249, 0].map((p) => assess(band, p))).toEqual([
    "flag",
    "flag",
    "escalate",
    "escalate",
    "pass",
    "pass",
  ]);
  expect([0.75, 0.749].map((p) => assess({ flag: 0.75, pass: 0.75 }, p))).toEqual(["flag", "pass"]);
});

test("the rules' bands over the labelled cases' measured p decide what the experiment measured", () => {
  const tally: Record<string, Record<string, number>> = {};
  for (const c of fixture.cases) {
    if (!c.selected) continue;
    const verdict = assess(ruleOf(c.rule), c.p);
    const row = (tally[c.rule] ??= {
      cases: 0,
      violations: 0,
      flagged: 0,
      wronglyFlagged: 0,
      escalated: 0,
      violationsPassed: 0,
    });
    row.cases++;
    row.violations += c.label;
    if (verdict === "flag") {
      row.flagged++;
      row.wronglyFlagged += 1 - c.label;
    }
    if (verdict === "escalate") row.escalated++;
    if (verdict === "pass" && c.label === 1) row.violationsPassed++;
  }
  expect(tally).toEqual({
    "comments/no-narrating-comments": {
      cases: 111,
      violations: 27,
      flagged: 21,
      wronglyFlagged: 1,
      escalated: 10,
      violationsPassed: 4,
    },
    "terminology/no-metaphorical-lane-door-seam": {
      cases: 103,
      violations: 96,
      flagged: 95,
      wronglyFlagged: 0,
      escalated: 1,
      violationsPassed: 0,
    },
    "typescript/explain-type-cast": {
      cases: 62,
      violations: 37,
      flagged: 19,
      wronglyFlagged: 1,
      escalated: 21,
      violationsPassed: 1,
    },
    "structure/validate-unknown-shapes": {
      cases: 65,
      violations: 35,
      flagged: 40,
      wronglyFlagged: 7,
      escalated: 0,
      violationsPassed: 2,
    },
    "structure/prefer-clear-conditionals": {
      cases: 49,
      violations: 15,
      flagged: 9,
      wronglyFlagged: 0,
      escalated: 5,
      violationsPassed: 3,
    },
  });
});

const PATCH = lines(
  "@@ -1,3 +1,6 @@",
  " import x;", // 1
  "+// uses the fast lane", // 2
  "+// and the slow lane", // 3
  " const y = 1;", // 4
  "+const z = y as Z;", // 5
  " export {};", // 6
  "@@ -20,2 +23,2 @@",
  " a();", // 23
  "+b();", // 24
);
const SOURCE = [
  "import x;",
  "// uses the fast lane",
  "// and the slow lane",
  "const y = 1;",
  "const z = y as Z;",
  "export {};",
  ...Array<string>(16).fill("f();"),
  "a();",
  "b();",
].join("\n");
const FILE = sourceFile("src/a.ts", SOURCE, [2, 3, 5, 24]);
const lane = ruleOf("terminology/no-metaphorical-lane-door-seam");
const cast = ruleOf("typescript/explain-type-cast");

test("a Jev finding: the unit's added lines, the rule's message, and what decided it", () => {
  expect(jevFinding(candidate(lane, 2, 3, "lane"), PATCH, { engine: "jev", p: 0.97 })).toEqual({
    rule: lane.id,
    path: "src/a.ts",
    startLine: 2,
    endLine: 3,
    message: "`lane` is used as a metaphor. Name the thing by what it is.",
    suggestion: null,
    key: `${lane.id}:src/a.ts:2`,
    decidedBy: { engine: "jev", p: 0.97 },
  });
  // context lines at the unit's edges are not part of the finding
  expect(
    [jevFinding(candidate(cast, 4, 6), PATCH, { engine: "jev", p: 1 })].map((f) => [
      f.startLine,
      f.endLine,
    ]),
  ).toEqual([[5, 5]]);
  // added lines in two hunks: GitHub takes a span only inside one, so the first added line
  expect(
    [jevFinding(candidate(cast, 3, 24), PATCH, { engine: "llm", p: 0.8 })].map((f) => [
      f.startLine,
      f.endLine,
    ]),
  ).toEqual([[3, 3]]);
});

test("escalation: the unsure candidates' windows as one numbered patch per file, and the LLM's verdict per candidate", () => {
  const other = sourceFile("src/b.ts", lines("x;", "const q = r as Q;", "y;"), [2]);
  const escalated: Candidate[] = [
    candidate(lane, 2, 2, "lane"),
    candidate(cast, 5, 5),
    { rule: cast, file: other, unit: { start: 2, end: 2, match: null, node: "r as Q" } },
  ];
  const files = escalationFiles(escalated);
  expect(files.map((file) => [file.path, file.rules])).toEqual([
    ["src/a.ts", [lane.id, cast.id]],
    ["src/b.ts", [cast.id]],
  ]);
  // ±8 lines around each unit, overlapping windows merged, the file's own added lines marked
  const numbered = numberedPatch(files[0].patch).split("\n");
  expect(numbered[0]).toBe("@@ -1,13 +1,13 @@");
  expect(numbered.slice(1, 7)).toEqual([
    "    1   import x;",
    "    2 + // uses the fast lane",
    "    3 + // and the slow lane",
    "    4   const y = 1;",
    "    5 + const z = y as Z;",
    "    6   export {};",
  ]);
  expect(numbered.length).toBe(14);
  const diagnostic = (
    rule: string,
    path: string,
    startLine: number,
    endLine: number,
  ): Diagnostic => ({
    rule,
    path,
    startLine,
    endLine,
    message: "m",
    suggestion: null,
    key: "k",
  });
  expect(
    confirmedEscalations(escalated, [
      diagnostic(cast.id, "src/a.ts", 4, 5), // overlaps the cast on 5
      diagnostic(lane.id, "src/a.ts", 7, 7), // not a candidate it was asked about
      diagnostic(lane.id, "src/b.ts", 2, 2), // the wrong rule for b.ts's candidate
    ]),
  ).toEqual([escalated[1]]);
});

/** The fixture's Jev rule `id`. */
function ruleOf(id: string) {
  const rule = rules.get(id);
  if (!rule) throw new Error(`no fixture rule ${id}`);
  return rule;
}

function lines(...text: string[]) {
  return text.join("\n");
}

/** Every line of `text`, 1-based: a file the pull request added whole. */
function all(text: string) {
  return text.split("\n").map((_, index) => index + 1);
}

/** A candidate of `rule` on FILE's lines `start`–`end`. */
function candidate(
  rule: JevRule,
  start: number,
  end: number,
  match: string | null = null,
): Candidate {
  return { rule, file: FILE, unit: { start, end, match, node: null } };
}
