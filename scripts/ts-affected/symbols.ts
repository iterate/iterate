// scripts/ts-affected/symbols.ts — EXPERIMENT (tasks/typescript-change-detection.md): the same
// nerf-and-read-errors trick as engine.ts, one top-level declaration at a time instead of a whole
// file. Renaming a declaration breaks exactly the code that references it; each error is mapped
// to the top-level statement around it (a declaration, an import, a `test(...)` call), and the next
// round renames those. A change to one function reaches its callers, not every importer of its file.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { parseSync } from "oxc-parser";

import { checkWithEdits, programsReading, type Diagnostic, type Repo } from "./engine.ts";

/** A top-level thing a change can reach. */
export type Item =
  /** A top-level declaration (value, type, or both under one name). Renamed to nerf it. */
  | { kind: "binding"; file: string; name: string }
  /** An import's local binding. Re-aliased to nerf it, so every use in the file stops resolving. */
  | { kind: "import"; file: string; name: string }
  /** An `export { a as name }` specifier, with or without `from`. Renamed to nerf it. */
  | { kind: "export"; file: string; name: string }
  | { kind: "default"; file: string }
  /**
   * Anything else: a `test(...)` call, a route registration, other top-level code. Nothing refers
   * to a statement, so it ends its chain. `label` names the innermost test around the error.
   */
  | { kind: "statement"; file: string; line: number; label: string };

export function itemKey(item: Item) {
  if (item.kind === "statement") return `${item.file}#L${item.line}:${item.label}`;
  if (item.kind === "default") return `${item.file}#default`;
  return `${item.file}#${item.kind}:${item.name}`;
}

type TextEdit = { start: number; end: number; text: string };

/**
 * Renames the seeds, collects the errors, turns each into the item around it, and repeats with
 * everything found so far until a round finds nothing that can itself be renamed.
 */
export async function symbolClosure(repo: Repo, seeds: Item[]) {
  const affected = new Map(seeds.map((item) => [itemKey(item), item]));
  /** Found item → the nerfed item its error names: the "because" for each step. */
  const via = new Map<string, string>();
  const rounds: Array<{ ms: number; programs: number; errors: number; found: number }> = [];
  let frontier = seeds.filter((item) => item.kind !== "statement");
  let previous = new Map<string, string>();
  while (frontier.length) {
    const editsByFile = new Map<string, TextEdit[]>();
    for (const item of affected.values()) {
      const edits = editsFor(repo, item);
      if (edits.length)
        editsByFile.set(item.file, [...(editsByFile.get(item.file) || []), ...edits]);
    }
    const contents = new Map(
      [...editsByFile].map(([file, edits]) => [
        file,
        applyEdits(parse(repo, file).source, dedupe(edits)),
      ]),
    );
    const changed = [...contents.keys()].filter(
      (file) => previous.get(file) !== contents.get(file),
    );
    previous = contents;
    const { diagnostics, ms, programs } = await checkWithEdits(
      repo,
      [...contents].map(([file, content]) => ({ file, content })),
      programsReading(repo, changed),
    );
    const found: Item[] = [];
    for (const d of diagnostics) {
      if (!d.file || !repo.programsByFile.has(d.file)) continue;
      const edited = contents.get(d.file) || parse(repo, d.file).source;
      const offset = originalOffset(
        dedupe(editsByFile.get(d.file) || []),
        offsetOf(edited, d.line, d.column),
      );
      for (const item of itemsAt(repo, d.file, offset)) {
        if (affected.has(itemKey(item))) continue;
        affected.set(itemKey(item), item);
        found.push(item);
        // No quoted name matches when the error arrived through an inferred type instead: a
        // nerfed binding's `any` flowed on and tripped noImplicitAny somewhere downstream.
        const cause = causeOf(d, [...affected.values()]);
        via.set(itemKey(item), cause ? itemKey(cause) : `(type flow: ${d.code})`);
      }
    }
    rounds.push({ ms, programs: programs.length, errors: diagnostics.length, found: found.length });
    frontier = found.filter((item) => item.kind !== "statement");
  }
  return { affected: [...affected.values()], via, rounds };
}

/**
 * The nerfed item a diagnostic complains about: the one whose name it quotes, in the same file for
 * "Cannot find name 'x'" and in another for "has no exported member 'x'".
 */
function causeOf(d: Diagnostic, affected: Item[]) {
  const quoted = [...d.message.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const named = affected.filter(
    (item) =>
      item.kind !== "statement" && quoted.includes(item.kind === "default" ? "default" : item.name),
  );
  const sameFile = d.code === "TS2304" || d.code === "TS2552";
  return named.find((item) => (item.file === d.file) === sameFile) || named[0];
}

/** The declaration (or re-export) a file exports as `name`. */
export function seedForExport(repo: Repo, file: string, name: string): Item {
  const { program } = parse(repo, file);
  if (name === "default") return { kind: "default", file };
  if (topLevelBindings(program).some((binding) => binding.name === name))
    return { kind: "binding", file, name };
  return { kind: "export", file, name };
}

/**
 * The items a diff touches, in the commit's own tree: every top-level statement that overlaps a
 * changed line of a TypeScript file. Files TypeScript cannot see (JSON, Markdown, YAML, CSS…) come
 * back separately.
 */
export function seedsFromDiff(repo: Repo, base: string) {
  const diff = execFileSync("git", ["diff", "--unified=0", "--no-renames", base, "HEAD"], {
    cwd: repo.root,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  const changedLines = new Map<string, number[]>();
  let file = "";
  for (const line of diff.split("\n")) {
    const header = line.match(/^\+\+\+ (?:b\/(.*)|\/dev\/null)$/);
    if (header) {
      file = header[1] || "";
      if (file) changedLines.set(file, []);
      continue;
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (hunk && file) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      // A pure deletion (count 0) touches the statement it was cut from.
      for (let i = 0; i < Math.max(count, 1); i++) changedLines.get(file)!.push(start + i);
    }
  }
  const seeds: Item[] = [];
  const invisible: string[] = [];
  for (const [file, lines] of changedLines) {
    if (!repo.programsByFile.has(file)) {
      invisible.push(file);
      continue;
    }
    const { program, source } = parse(repo, file);
    const lineStarts = [0, ...[...source.matchAll(/\n/g)].map((m) => m.index + 1)];
    for (const line of lines) {
      const offset = lineStarts[Math.min(line, lineStarts.length) - 1];
      const statement = program.body.find((s: any) => s.start <= offset && offset <= s.end);
      if (!statement || statement.type === "ImportDeclaration") continue;
      // An edited line touches every name its statement declares.
      for (const item of itemsAt(repo, file, statement.start)) {
        if (!seeds.some((seed) => itemKey(seed) === itemKey(item))) seeds.push(item);
      }
    }
  }
  return { seeds, invisible, files: [...changedLines.keys()] };
}

/** What a diagnostic at `offset` in `file` belongs to. */
function itemsAt(repo: Repo, file: string, offset: number): Item[] {
  const { program, source } = parse(repo, file);
  const statement = program.body.find((s: any) => s.start <= offset && offset <= s.end);
  if (!statement) return [];
  const within = (node: any) => node.start <= offset && offset <= node.end;
  switch (statement.type) {
    case "ImportDeclaration": {
      const specifiers = statement.specifiers.filter(within);
      return (specifiers.length ? specifiers : statement.specifiers).map((s: any) => ({
        kind: "import",
        file,
        name: s.local.name,
      }));
    }
    case "ExportNamedDeclaration": {
      if (statement.declaration) return declarationItems(file, statement.declaration, offset);
      const specifiers = statement.specifiers.filter(within);
      return (specifiers.length ? specifiers : statement.specifiers).map((s: any) => ({
        kind: "export",
        file,
        name: s.exported.name,
      }));
    }
    case "ExportDefaultDeclaration":
      return [{ kind: "default", file }];
    default: {
      const items = declarationItems(file, statement, offset);
      if (items.length) return items;
      const test = testAt(statement, offset);
      const line = source.slice(0, test?.start ?? statement.start).split("\n").length;
      return [{ kind: "statement", file, line, label: test?.title || "(top-level code)" }];
    }
  }
}

function declarationItems(file: string, declaration: any, offset: number): Item[] {
  if (declaration.type === "VariableDeclaration") {
    const declarators = declaration.declarations.filter(
      (d: any) => d.start <= offset && offset <= d.end,
    );
    return (declarators.length ? declarators : declaration.declarations)
      .flatMap((d: any) => patternBindings(d.id))
      .map((id: any) => ({ kind: "binding", file, name: id.name }));
  }
  if (declaration.type === "TSModuleDeclaration" && declaration.kind === "global") return [];
  if (declaration.id?.type === "Identifier")
    return [{ kind: "binding", file, name: declaration.id.name }];
  return [];
}

/**
 * The text edits that nerf an item. Every edit renames or re-aliases an identifier, so the file
 * still parses and the only new errors are at references.
 */
function editsFor(repo: Repo, item: Item): TextEdit[] {
  if (item.kind === "statement") return [];
  const { program } = parse(repo, item.file);
  if (item.kind === "binding") {
    return topLevelBindings(program)
      .filter((binding) => binding.name === item.name)
      .map((binding) => ({
        start: binding.start,
        end: binding.end,
        // `const { a } = x` has to stay a destructure of `a`.
        text: binding.shorthand ? `${item.name}: ${item.name}__nerfed` : `${item.name}__nerfed`,
      }));
  }
  if (item.kind === "import") {
    return program.body
      .filter((s: any) => s.type === "ImportDeclaration")
      .flatMap((s: any) => s.specifiers)
      .filter((s: any) => s.local.name === item.name)
      .map((s: any) => ({
        start: s.local.start,
        end: s.local.end,
        text:
          s.imported && s.imported.start === s.local.start
            ? `${item.name} as __nerfed_${item.name}`
            : `__nerfed_${item.name}`,
      }));
  }
  if (item.kind === "export") {
    return program.body
      .filter((s: any) => s.type === "ExportNamedDeclaration" && !s.declaration)
      .flatMap((s: any) => s.specifiers)
      .filter((s: any) => s.exported.name === item.name)
      .map((s: any) => ({
        start: s.exported.start,
        end: s.exported.end,
        text:
          s.exported.start === s.local.start
            ? `${item.name} as ${item.name}__nerfed`
            : `${item.name}__nerfed`,
      }));
  }
  const statement = program.body.find((s: any) => s.type === "ExportDefaultDeclaration");
  if (!statement || statement.declaration.type === "TSInterfaceDeclaration") return [];
  return [
    {
      start: statement.start,
      end: statement.declaration.start,
      text: "export const __nerfed_default = ",
    },
  ];
}

type Binding = { name: string; start: number; end: number; shorthand: boolean };

/** Every name the file declares at the top level, at its declaring identifier. */
function topLevelBindings(program: any): Binding[] {
  return program.body.flatMap((statement: any) => {
    const declaration =
      statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration"
        ? statement.declaration
        : statement;
    if (!declaration) return [];
    if (declaration.type === "VariableDeclaration")
      return declaration.declarations.flatMap((d: any) => patternBindings(d.id));
    if (declaration.type === "TSModuleDeclaration" && declaration.kind === "global") return [];
    if (declaration.id?.type === "Identifier")
      return [
        {
          name: declaration.id.name,
          start: declaration.id.start,
          end: declaration.id.end,
          shorthand: false,
        },
      ];
    return [];
  });
}

function patternBindings(pattern: any, shorthand = false): Binding[] {
  if (!pattern) return [];
  switch (pattern.type) {
    case "Identifier":
      return [{ name: pattern.name, start: pattern.start, end: pattern.end, shorthand }];
    case "ObjectPattern":
      return pattern.properties.flatMap((p: any) =>
        p.type === "RestElement"
          ? patternBindings(p.argument)
          : patternBindings(p.value, p.shorthand),
      );
    case "ArrayPattern":
      return pattern.elements.flatMap((e: any) => patternBindings(e));
    case "AssignmentPattern":
      return patternBindings(pattern.left, shorthand);
    case "RestElement":
      return patternBindings(pattern.argument);
    default:
      return [];
  }
}

const testCallee =
  /^(test|it|describe)(\.(only|skip|each|concurrent|fails|fail|todo|serial|describe))*$/;

/** The innermost `test(...)`/`it(...)` call around `offset` (or `describe(...)`, if no test is). */
function testAt(node: any, offset: number) {
  let found: { title: string; start: number; describe: boolean } | undefined;
  const visit = (n: any) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach(visit);
    if (typeof n.start === "number" && (n.start > offset || n.end < offset)) return;
    if (n.type === "CallExpression" && testCallee.test(calleeName(n.callee))) {
      const first = n.arguments[0];
      const text =
        first?.type === "Literal"
          ? String(first.value)
          : first?.type === "TemplateLiteral"
            ? first.quasis.map((q: any) => q.value.cooked).join("${}")
            : undefined;
      const describe = /describe/.test(calleeName(n.callee));
      if (text && !(describe && found && !found.describe))
        found = {
          title: `${calleeName(n.callee).split(".")[0]}: ${text}`,
          start: n.start,
          describe,
        };
    }
    for (const key in n) if (key !== "type" && key !== "start" && key !== "end") visit(n[key]);
  };
  visit(node);
  return found;
}

function calleeName(callee: any): string {
  if (callee?.type === "Identifier") return callee.name;
  if (callee?.type === "MemberExpression" && !callee.computed)
    return `${calleeName(callee.object)}.${callee.property.name}`;
  if (callee?.type === "CallExpression") return calleeName(callee.callee);
  return "";
}

const parsed = new Map<string, { source: string; program: any }>();
function parse(repo: Repo, file: string) {
  const key = path.join(repo.root, file);
  if (!parsed.has(key)) {
    const source = existsSync(key) ? readFileSync(key, "utf8") : "";
    parsed.set(key, { source, program: parseSync(file, source, { sourceType: "module" }).program });
  }
  return parsed.get(key)!;
}

function dedupe(edits: TextEdit[]) {
  return [...new Map(edits.map((edit) => [edit.start, edit])).values()].sort(
    (a, b) => a.start - b.start,
  );
}

function applyEdits(source: string, edits: TextEdit[]) {
  let result = "";
  let cursor = 0;
  for (const edit of edits) {
    result += source.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  return result + source.slice(cursor);
}

/** Maps an offset in the edited text back to the original, where the AST's offsets are. */
function originalOffset(edits: TextEdit[], editedOffset: number) {
  let delta = 0;
  for (const edit of edits) {
    const editedStart = edit.start + delta;
    if (editedOffset < editedStart) break;
    if (editedOffset < editedStart + edit.text.length) return edit.start;
    delta += edit.text.length - (edit.end - edit.start);
  }
  return editedOffset - delta;
}

/** tsc's 1-based line and column to a string offset. */
function offsetOf(source: string, line: number, column: number) {
  let offset = 0;
  for (let i = 1; i < line; i++) offset = source.indexOf("\n", offset) + 1;
  return offset + column - 1;
}
