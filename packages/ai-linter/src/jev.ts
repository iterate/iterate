// ai-linter/jev.ts — the Jev engine's pure half: the fixed selectors that pick the units a Jev rule
// judges on a pull request's added lines, each unit's request, the band that turns Jev's p into a
// finding, nothing, or a question for the LLM, that question, and the excerpts a model reads instead
// of a whole diff. run.ts does the I/O.
//
// The selectors pick the units the rules' thresholds were measured on, and a request is byte for byte
// the one they were measured with, one unit per request (fixtures/jev-cases.json holds the labelled
// cases): a request holding 25 units answers with less extreme p's, so at the same thresholds it
// flags 16 of explain-type-cast's 80 violations instead of 50, and passes 11 of them unseen instead
// of 1. A unit costs ~800 input tokens at $0.042/M.
import { parse, type ParseResult } from "@babel/parser";
import type { File, Node } from "@babel/types";
import { z } from "zod";
import type {
  Diagnostic,
  Finding,
  JevRule,
  ReviewedFile,
  Rule,
  Selector,
  UnitWindow,
} from "./lint.ts";
import { rightSide } from "./lint.ts";

/** A unit a selector picked: its 1-based inclusive lines, the words a `line` selector matched, and
 *  an AST selector's node text. */
export type Unit = { start: number; end: number; match: string | null; node: string | null };

/** A file at the pull request's head, and the lines the pull request added to it. */
export type SourceFile = {
  path: string;
  text: string;
  lines: string[];
  added: Set<number>;
  /** Why the file does not parse, or null; a file that does not parse has no AST units. */
  parseError(): string | null;
};

/** Each file's parse, once: a file with several AST rules is parsed for the first. */
const parsed = new WeakMap<
  SourceFile,
  { program: ParseResult<File> | null; error: string | null }
>();

export function sourceFile(path: string, text: string, added: Iterable<number>): SourceFile {
  const file: SourceFile = {
    path,
    text,
    lines: text.split("\n"),
    added: new Set(added),
    parseError: () => parseOf(file).error,
  };
  return file;
}

function parseOf(file: SourceFile) {
  let result = parsed.get(file);
  if (!result) {
    const typescript = /\.(ts|mts|cts|tsx)$/.test(file.path);
    const jsx = /\.(tsx|jsx|js|mjs|cjs)$/.test(file.path);
    try {
      const program = parse(file.text, {
        sourceType: "module",
        // a node's parenthesized expression stays a node, as TypeScript's own parser keeps it
        createParenthesizedExpressions: true,
        errorRecovery: true,
        allowReturnOutsideFunction: true,
        allowAwaitOutsideFunction: true,
        allowImportExportEverywhere: true,
        allowUndeclaredExports: true,
        allowSuperOutsideMethod: true,
        allowNewTargetOutsideFunction: true,
        plugins: [
          ...(typescript ? (["typescript"] as const) : []),
          ...(jsx ? (["jsx"] as const) : []),
          "decorators-legacy",
        ],
      });
      result = { program, error: null };
    } catch (error) {
      result = { program: null, error: error instanceof Error ? error.message : String(error) };
    }
    parsed.set(file, result);
  }
  return result;
}

/** The units `selector` picks in `file`: each touches a line the pull request added. */
export function selectUnits(selector: Selector, file: SourceFile): Unit[] {
  switch (selector.kind) {
    case "comment":
      return commentUnits(file);
    case "line":
      return lineUnits(file, selector.pattern);
    case "cast":
      return astUnits(file, isCast);
    case "conditional":
      return astUnits(file, isConditional, { anchorOnStart: true });
    case "shape":
      return astUnits(file, (node, ancestors) => isShapeCheck(node, ancestors, file.text));
  }
}

const HASH_COMMENT = /\.(ya?ml|sh|bash|toml|py)$|(^|\/)(Dockerfile|Makefile)$/;

/** Runs of comment-only lines (`//`, `/* *\/`, or `#` in YAML and shell), and a trailing comment
 *  after code as its own unit. A lint directive or a separator alone is not a comment to judge. */
function commentUnits(file: SourceFile): Unit[] {
  const { lines, added } = file;
  const hash = HASH_COMMENT.test(file.path);
  const units: Unit[] = [];
  let inBlock = false;
  let runStart = -1;
  const flush = (endIndex: number) => {
    if (runStart < 0) return;
    const start = runStart + 1;
    const end = endIndex + 1;
    runStart = -1;
    let anyAdded = false;
    for (let line = start; line <= end; line++) if (added.has(line)) anyAdded = true;
    const text = lines.slice(start - 1, end).join("\n");
    if (
      anyAdded &&
      /[a-z]{3}/i.test(text.replace(/(iterate-lint|eslint|oxlint)-[\w-]+.*|@ts-[\w-]+/g, ""))
    )
      units.push({ start, end, match: null, node: null });
  };
  for (let index = 0; index < lines.length; index++) {
    const trimmed = lines[index]!.trim();
    let commentOnly: boolean;
    if (hash) commentOnly = trimmed.startsWith("#") && !trimmed.startsWith("#!");
    else if (inBlock) {
      commentOnly = true;
      if (trimmed.includes("*/")) inBlock = false;
    } else if (trimmed.startsWith("//")) commentOnly = true;
    else if (trimmed.startsWith("/*")) {
      commentOnly = true;
      if (!trimmed.slice(2).includes("*/")) inBlock = true;
    } else commentOnly = false;
    if (commentOnly) {
      if (runStart < 0) runStart = index;
      continue;
    }
    flush(index - 1);
    const trailing = hash ? /\s#\s(.{12,})$/ : /[;,)}\]{]\s*\/\/\s?(.{12,})$/;
    if (trailing.test(lines[index]!) && added.has(index + 1))
      units.push({ start: index + 1, end: index + 1, match: null, node: null });
  }
  flush(lines.length - 1);
  return units;
}

const WORD = /[A-Za-z_]/;

/** Added lines the pattern matches, with every whole word a match falls in: a match inside a
 *  camelCase identifier is the whole identifier. */
function lineUnits(file: SourceFile, pattern: string): Unit[] {
  const units: Unit[] = [];
  for (const line of [...file.added].sort((a, b) => a - b)) {
    const text = file.lines[line - 1] ?? "";
    const words: string[] = [];
    for (const match of text.matchAll(new RegExp(pattern, "g"))) {
      let from = match.index;
      let to = match.index + match[0].length;
      while (from < to && !WORD.test(text[from]!)) from++;
      while (to > from && !WORD.test(text[to - 1]!)) to--;
      if (from === to) continue;
      while (from > 0 && WORD.test(text[from - 1]!)) from--;
      while (to < text.length && WORD.test(text[to]!)) to++;
      words.push(text.slice(from, to));
    }
    if (words.length)
      units.push({ start: line, end: line, match: [...new Set(words)].join(", "), node: null });
  }
  return units;
}

/** The AST nodes `pick` accepts, in source order (outer before inner). A unit counts when any of its
 *  lines was added, or, with `anchorOnStart`, its first line. */
function astUnits(
  file: SourceFile,
  pick: (node: Node, ancestors: Node[]) => boolean,
  options: { anchorOnStart?: boolean } = {},
): Unit[] {
  const { program } = parseOf(file);
  if (!program) return [];
  const units: Unit[] = [];
  const visit = (node: Node, ancestors: Node[]) => {
    if (pick(node, ancestors) && node.loc && node.start != null && node.end != null) {
      const start = node.loc.start.line;
      const end = node.loc.end.line;
      let hit = false;
      for (let line = start; line <= (options.anchorOnStart ? start : end); line++)
        if (file.added.has(line)) hit = true;
      if (hit) units.push({ start, end, match: null, node: file.text.slice(node.start, node.end) });
    }
    const path = [...ancestors, node];
    for (const child of childrenOf(node)) visit(child, path);
  };
  visit(program.program, []);
  return units;
}

const NOT_CHILDREN = new Set([
  "loc",
  "extra",
  "leadingComments",
  "trailingComments",
  "innerComments",
  "comments",
  "tokens",
]);

/** A node's child nodes in source order. */
function childrenOf(node: Node): Node[] {
  const children: Node[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (NOT_CHILDREN.has(key)) continue;
    for (const item of Array.isArray(value) ? value : [value])
      if (isNode(item)) children.push(item);
  }
  return children.sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
}

/** Babel's AST: every node is an object with a string `type`. */
const isNode = (value: unknown): value is Node =>
  value instanceof Object && typeof Reflect.get(value, "type") === "string";

/** `as const` asserts nothing about a value's type: it keeps a literal narrow and read-only. */
const isConstType = (type: Node) =>
  type.type === "TSTypeReference" &&
  type.typeName.type === "Identifier" &&
  type.typeName.name === "const";

function isCast(node: Node): boolean {
  if (node.type === "TSAsExpression" || node.type === "TSTypeAssertion")
    return !isConstType(node.typeAnnotation);
  return false;
}

/** The outermost ternary of a chain (parentheses do not start a new one), and an `if` with an
 *  `else` that is not an `else if`. */
function isConditional(node: Node, ancestors: Node[]): boolean {
  const parent = ancestors.at(-1);
  if (node.type === "ConditionalExpression") {
    const outer = ancestors.findLast((ancestor) => ancestor.type !== "ParenthesizedExpression");
    return outer?.type !== "ConditionalExpression";
  }
  if (node.type === "IfStatement")
    return (
      Boolean(node.alternate) && !(parent?.type === "IfStatement" && parent.alternate === node)
    );
  return false;
}

const isAndOr = (node: Node) =>
  node.type === "LogicalExpression" && (node.operator === "&&" || node.operator === "||");

const unwrap = (node: Node): Node =>
  node.type === "ParenthesizedExpression" ? unwrap(node.expression) : node;

/** One runtime shape test: typeof, a null comparison, `in`, instanceof or Array.isArray, maybe negated. */
function isShapeTest(node: Node, source: string): boolean {
  node = unwrap(node);
  if (node.type === "UnaryExpression" && node.operator === "!")
    return isShapeTest(node.argument, source);
  if (node.type === "BinaryExpression") {
    const { operator, left, right } = node;
    if (["===", "!==", "==", "!="].includes(operator))
      return [left, right].some(
        (side) =>
          (side.type === "UnaryExpression" && side.operator === "typeof") ||
          side.type === "NullLiteral",
      );
    return operator === "in" || operator === "instanceof";
  }
  if (node.type === "CallExpression") {
    const { callee } = node;
    return (
      callee.start != null &&
      callee.end != null &&
      source.slice(callee.start, callee.end) === "Array.isArray"
    );
  }
  return false;
}

function shapeTests(node: Node, source: string): number {
  node = unwrap(node);
  if (node.type === "LogicalExpression" && isAndOr(node))
    return shapeTests(node.left, source) + shapeTests(node.right, source);
  return isShapeTest(node, source) ? 1 : 0;
}

/** A `&&`/`||` chain (the outermost) of two or more shape tests, or parsed JSON asserted to a type. */
function isShapeCheck(node: Node, ancestors: Node[], source: string): boolean {
  if (isAndOr(node)) {
    const parent = ancestors.findLast((ancestor) => ancestor.type !== "ParenthesizedExpression");
    if (parent && isAndOr(parent)) return false;
    return shapeTests(node, source) >= 2;
  }
  if (node.type === "TSAsExpression") {
    const inner = unwrap(node.expression);
    if (inner.start == null || inner.end == null) return false;
    return /^(await\s+)?JSON\.parse\(|\.json\(\)$/.test(source.slice(inner.start, inner.end));
  }
  return false;
}

/** The unit with `before` and `after` lines around it, the unit's own lines marked `>`. */
function windowText(
  lines: string[],
  start: number,
  end: number,
  before: number,
  after: number,
): string {
  const out: string[] = [];
  for (let line = Math.max(1, start - before); line <= Math.min(lines.length, end + after); line++)
    out.push(`${line >= start && line <= end ? ">" : " "} ${lines[line - 1]}`);
  return out.join("\n");
}

/** What the unit is called in the state Jev reads. */
const NOUN: Record<Exclude<Selector["kind"], "cast">, string> = {
  comment: "comment",
  line: "line",
  conditional: "conditional",
  shape: "expression",
};

export type JevQuestion = {
  type: "noul";
  instructions: string;
  criteria: { true: string; false: string };
};

/** One unit's request: the file's path and the unit's window as the state, the rule's yes/no question
 *  as `v`. A cast's state names its exact assertion, since a line can hold several. */
export function jevRequest(
  rule: JevRule,
  file: SourceFile,
  unit: Unit,
): { state: string; questions: { v: JevQuestion } } {
  const window = windowText(
    file.lines,
    unit.start,
    unit.end,
    rule.window.before,
    rule.window.after,
  );
  const where = 'on the lines marked ">"; unmarked lines are surrounding context.';
  const state =
    rule.select.kind === "cast"
      ? `File: ${file.path}\nAssertion under review: \`${(unit.node || "").replace(/\s+/g, " ").slice(0, 300)}\`\nIt is ${where}\n\n${window}`
      : `File: ${file.path}\nThe ${NOUN[rule.select.kind]} under review is ${where}\n\n${window}`;
  const fill = (text: string) => text.replaceAll("{match}", unit.match || "");
  return {
    state,
    questions: {
      v: {
        type: "noul",
        instructions: fill(rule.question.instructions),
        criteria: { true: fill(rule.question.true), false: fill(rule.question.false) },
      },
    },
  };
}

const JevResult = z.object({
  answers: z.object({ v: z.object({ noul: z.number().min(0).max(1) }) }),
  usage: z.object({ input_tokens: z.number() }).optional(),
});
/** Workers AI's binding wraps the model's answer in `result`; the REST API's `result.result` is the same. */
const JevAnswer = z.union([
  z.object({ result: JevResult }).transform(({ result }) => result),
  JevResult,
]);

/** Jev's answer to one request: p that the unit violates the rule, and the input tokens it read. */
export function jevAnswer(answer: unknown): { p: number; inputTokens: number } {
  const parsed = JevAnswer.safeParse(answer);
  if (!parsed.success)
    throw new Error(`Jev answered no p: ${JSON.stringify(answer)?.slice(0, 300)}`);
  return { p: parsed.data.answers.v.noul, inputTokens: parsed.data.usage?.input_tokens ?? 0 };
}

/** p at or above flag is a finding; below pass, nothing; in between, the LLM decides. */
export function assess(
  band: { flag: number; pass: number },
  p: number,
): "flag" | "pass" | "escalate" {
  if (p >= band.flag) return "flag";
  if (p < band.pass) return "pass";
  return "escalate";
}

/** A unit a Jev rule judges. */
export type Candidate = { rule: JevRule; file: SourceFile; unit: Unit };

/** A candidate as a published finding: its added lines (the first alone when they cross a hunk),
 *  the rule's message, and what decided it. */
export function jevFinding(
  candidate: Candidate,
  patch: string,
  decidedBy: Finding["decidedBy"],
): Finding {
  const { rule, file, unit } = candidate;
  const { shown } = rightSide(patch);
  const added: number[] = [];
  for (let line = unit.start; line <= unit.end; line++) if (file.added.has(line)) added.push(line);
  const startLine = added[0] ?? unit.start;
  let endLine = added.at(-1) ?? unit.end;
  for (let line = startLine; line <= endLine; line++) if (!shown.has(line)) endLine = startLine;
  return {
    rule: rule.id,
    path: file.path,
    startLine,
    endLine,
    message: rule.message.replaceAll("{match}", unit.match || ""),
    suggestion: null,
    key: `${rule.id}:${file.path}:${startLine}`,
    decidedBy,
  };
}

/** The unsure candidates as the LLM reads them, each with 8 lines around it, as its baseline was
 *  measured (`unitExcerpts`). */
export function escalationFiles(candidates: Candidate[]): ReviewedFile[] {
  return unitExcerpts(
    candidates.map((candidate) => ({ ...candidate, window: { before: 8, after: 8 } })),
  );
}

/** Units as a model reads them instead of a whole diff: per file, each unit's window (merged where
 *  they overlap) as a hunk with the file's added lines marked, and the rules they are about. */
export function unitExcerpts(
  units: { rule: Rule; file: SourceFile; unit: Unit; window: UnitWindow }[],
): ReviewedFile[] {
  const byPath = new Map<string, typeof units>();
  for (const unit of units)
    byPath.set(unit.file.path, [...(byPath.get(unit.file.path) ?? []), unit]);
  return [...byPath.values()].map((inFile) => {
    const { file } = inFile[0]!;
    const ranges = inFile
      .map(({ unit, window }) => [
        Math.max(1, unit.start - window.before),
        Math.min(file.lines.length, unit.end + window.after),
      ])
      .sort((a, b) => a[0]! - b[0]!);
    const merged: number[][] = [];
    for (const [from, to] of ranges) {
      const last = merged.at(-1);
      if (last && from! <= last[1]! + 1) last[1] = Math.max(last[1]!, to!);
      else merged.push([from!, to!]);
    }
    const patch = merged
      .map(([from, to]) => {
        const count = to! - from! + 1;
        const body = file.lines
          .slice(from! - 1, to)
          .map((text, index) => `${file.added.has(from! + index) ? "+" : " "}${text}`);
        return [`@@ -${from},${count} +${from},${count} @@`, ...body].join("\n");
      })
      .join("\n");
    return { path: file.path, patch, rules: [...new Set(inFile.map(({ rule }) => rule.id))] };
  });
}

/** The unsure candidates the LLM found violating: a diagnostic of the candidate's rule, in its file,
 *  overlapping its unit. What else it reports in those windows is not what it was asked. */
export function confirmedEscalations(
  candidates: Candidate[],
  diagnostics: Diagnostic[],
): Candidate[] {
  return candidates.filter(({ rule, file, unit }) =>
    diagnostics.some(
      (diagnostic) =>
        diagnostic.rule === rule.id &&
        diagnostic.path === file.path &&
        diagnostic.startLine <= unit.end &&
        diagnostic.endLine >= unit.start,
    ),
  );
}
