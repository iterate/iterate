// Generates src/itx/examples.generated.ts — the plain-JS-string form of the
// itx example catalogue — from the typed-function source module
// src/itx/examples-source.ts. Freshness is enforced by
// src/itx/examples.generated.test.ts; regenerate with
// `pnpm generate:itx-examples`.
//
// HOW BODIES ARE DERIVED — original source text, not Function.toString().
// Every runtime consumes each entry as a plain-JS body string, and the
// string must be produced at generation time in Node (production bundles
// minify: client-side `fn.toString()` returns mangled parameter names,
// breaking both display and `AsyncFunction("itx","vars",body)` execution).
// Within Node there were two candidate derivations, and toString lost on
// evidence: `tsx` MINIFIES its transform output (comments — the catalogue's
// teaching material — are destroyed), and the non-minifying oxc transform
// (what vitest uses) re-prints bodies with tabs, normalized quotes, and NO
// BLANK LINES. Extracting the `fn` body's ORIGINAL text via the TypeScript
// AST keeps every byte the author wrote — comments, paragraph breaks,
// embedded template strings — and needs no transform at all. (This is also
// the first step toward the end state: generating script/catalogue source
// from the type graph itself.)
//
// What the generator enforces per entry:
// - `fn` is a BLOCK-BODIED `async (itx) => { … }` / `async (itx, vars…) =>
//   { … }` arrow (the body is unwrapped verbatim, then de-indented — lines
//   inside template-literal quasis are span-protected and never touched).
// - The extracted body is plain JavaScript: it must parse under the JS-only
//   AsyncFunction constructor, so TS residue inside a body (annotations,
//   casts, `!`) fails generation instead of shipping.
// - Metadata parsed from the module at runtime matches the AST entry count
//   and per-entry authoring shape (fn XOR code).

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { ITX_EXAMPLE_RUNTIMES } from "../src/itx/examples.ts";
import { ITX_EXAMPLE_SOURCES } from "../src/itx/examples-source.ts";

const projectDir = fileURLToPath(new URL("..", import.meta.url));
const sourcePath = path.join(projectDir, "src/itx/examples-source.ts");
const outPath = path.join(projectDir, "src/itx/examples.generated.ts");

const AsyncFunction = async function () {}.constructor as new (...args: string[]) => unknown;

export function generateItxExamples(): string {
  const sourceText = readFileSync(sourcePath, "utf8");
  const bodies = extractFnBodies(sourceText);

  // Belt and braces: ALL_RUNTIMES in the source module is a hand-maintained
  // copy of the public tuple (the source module cannot import the value —
  // its entries must stay self-contained data); a drifted member would
  // silently narrow every entry, so check via the parsed metadata.
  for (const entry of ITX_EXAMPLE_SOURCES) {
    for (const runtime of entry.runtimes) {
      if (!ITX_EXAMPLE_RUNTIMES.includes(runtime)) {
        throw new Error(`example "${entry.id}": unknown runtime "${runtime}"`);
      }
    }
  }

  if (
    bodies.size + ITX_EXAMPLE_SOURCES.filter((entry) => !!entry.code).length !==
    ITX_EXAMPLE_SOURCES.length
  ) {
    throw new Error(
      `examples-source.ts: ${ITX_EXAMPLE_SOURCES.length} entries, but ` +
        `${bodies.size} fn bodies + ` +
        `${ITX_EXAMPLE_SOURCES.filter((entry) => !!entry.code).length} code strings — `,
    );
  }

  const entries = ITX_EXAMPLE_SOURCES.map((entry) => {
    const fromFn = bodies.get(entry.id);
    if (!fromFn === !entry.code) {
      throw new Error(`example "${entry.id}": exactly one of fn / code must be authored`);
    }
    const code = fromFn ?? entry.code!;
    // The one property every runtime relies on: the body is plain JavaScript
    // (AsyncFunction is JS-only, so TS residue inside a body throws here).
    try {
      void new AsyncFunction("itx", "vars", code);
    } catch (error) {
      throw new Error(
        `example "${entry.id}": body is not plain JavaScript (${String(error)}).\n` +
          `Keep TypeScript in the parameter annotations and Extra widenings — ` +
          `the body ships verbatim to every runtime.\n\n${code}`,
      );
    }
    return { ...entry, code };
  });

  const rendered = entries.map((entry) => {
    const lines: string[] = ["  {"];
    lines.push(`    id: ${JSON.stringify(entry.id)},`);
    if (entry.e2eProven === false) lines.push(`    e2eProven: false,`);
    lines.push(`    title: ${JSON.stringify(entry.title)},`);
    lines.push(`    description: ${JSON.stringify(entry.description)},`);
    lines.push(`    context: ${JSON.stringify(entry.context)},`);
    lines.push(`    runtimes: ${JSON.stringify(entry.runtimes)},`);
    const escaped = entry.code
      .replaceAll("\\", "\\\\")
      .replaceAll("`", "\\`")
      .replaceAll("${", "\\${");
    lines.push(`    code: \`\n${escaped}\n\`.trim(),`);
    lines.push("  },");
    return lines.join("\n");
  });

  const raw = [
    "// GENERATED by scripts/generate-itx-examples.ts — do not edit.",
    "// Regenerate with: pnpm generate:itx-examples",
    "// Freshness is enforced by examples.generated.test.ts.",
    "//",
    "// The catalogue is AUTHORED as typed functions in ./examples-source.ts;",
    "// each entry's `code` here is that function's body, extracted verbatim",
    "// from the original source text (never Function.toString — production",
    "// bundles minify). Import through ./examples.ts, not this file.",
    'import type { ItxExample } from "./examples.ts";',
    "",
    `export const ITX_EXAMPLES: ItxExample[] = [`,
    ...rendered,
    `];`,
    "",
  ].join("\n");

  // Format through the repo's formatter so the emitted file is byte-stable
  // (the freshness test compares exact text). oxfmt never reformats template
  // literal contents, so the extracted bodies stay byte-exact.
  return execFileSync(
    path.join(projectDir, "../../node_modules/.bin/oxfmt"),
    [`--stdin-filepath=${outPath}`],
    { encoding: "utf8", input: raw },
  );
}

/**
 * Parse examples-source.ts and return each typed entry's fn BODY text,
 * keyed by the entry's `id` literal, de-indented (template-literal interior
 * lines span-protected) and trimmed.
 */
function extractFnBodies(sourceText: string): Map<string, string> {
  const sourceFile = ts.createSourceFile(
    sourcePath,
    sourceText,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
  );

  const arrayLiteral = findSourcesArray(sourceFile);
  const bodies = new Map<string, string>();

  for (const element of arrayLiteral.elements) {
    if (!ts.isCallExpression(element) || element.arguments.length !== 1) {
      throw new Error(
        `examples-source.ts: every ITX_EXAMPLE_SOURCES element must be a single-argument ` +
          `helper call — got \`${element.getText(sourceFile).slice(0, 80)}…\``,
      );
    }
    const objectLiteral = element.arguments[0]!;
    if (!ts.isObjectLiteralExpression(objectLiteral)) {
      throw new Error(`examples-source.ts: helper argument must be an object literal`);
    }
    const id = propertyStringValue(objectLiteral, "id", sourceFile);
    const fnProperty = objectLiteral.properties.find(
      (property) =>
        ts.isPropertyAssignment(property) &&
        ts.isIdentifier(property.name) &&
        property.name.text === "fn",
    ) as ts.PropertyAssignment | undefined;
    if (!fnProperty) continue; // a stringExample entry — its `code` rides the metadata import

    const fn = fnProperty.initializer;
    if (!ts.isArrowFunction(fn) || !ts.isBlock(fn.body)) {
      throw new Error(
        `example "${id}": fn must be a BLOCK-BODIED arrow (async (itx[, vars]) => { … }) — ` +
          `the generator unwraps the block to the runtime body`,
      );
    }
    if (fn.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) !== true) {
      throw new Error(`example "${id}": fn must be async`);
    }
    const parameterNames = fn.parameters.map((parameter) => parameter.name.getText(sourceFile));
    const expected = parameterNames.length === 1 ? ["itx"] : ["itx", "vars"];
    if (JSON.stringify(parameterNames) !== JSON.stringify(expected)) {
      throw new Error(
        `example "${id}": fn parameters must be (itx) or (itx, vars) — got (${parameterNames.join(", ")})`,
      );
    }

    const body = unwrapBlockBody(fn.body, sourceFile, sourceText, id);
    if (bodies.has(id)) throw new Error(`duplicate example id "${id}"`);
    bodies.set(id, body);
  }

  return bodies;
}

function findSourcesArray(sourceFile: ts.SourceFile): ts.ArrayLiteralExpression {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === "ITX_EXAMPLE_SOURCES" &&
        declaration.initializer &&
        ts.isArrayLiteralExpression(declaration.initializer)
      ) {
        return declaration.initializer;
      }
    }
  }
  throw new Error("examples-source.ts: could not find the ITX_EXAMPLE_SOURCES array literal");
}

function propertyStringValue(
  objectLiteral: ts.ObjectLiteralExpression,
  name: string,
  sourceFile: ts.SourceFile,
): string {
  for (const property of objectLiteral.properties) {
    if (
      ts.isPropertyAssignment(property) &&
      ts.isIdentifier(property.name) &&
      property.name.text === name &&
      ts.isStringLiteral(property.initializer)
    ) {
      return property.initializer.text;
    }
  }
  throw new Error(
    `examples-source.ts: entry is missing a literal "${name}" property ` +
      `(near: ${objectLiteral.getText(sourceFile).slice(0, 80)}…)`,
  );
}

/**
 * The block's interior, de-indented. Lines whose start falls inside a
 * template-literal QUASI span keep their exact bytes — their leading
 * whitespace is string content, not indentation (the seeded worker sources,
 * the scheduler scripts). Everything else sheds the block's base indent.
 */
function unwrapBlockBody(
  block: ts.Block,
  sourceFile: ts.SourceFile,
  sourceText: string,
  id: string,
): string {
  const interiorStart = block.getStart(sourceFile) + 1; // past `{`
  const interiorEnd = block.getEnd() - 1; // before `}`
  const interior = sourceText.slice(interiorStart, interiorEnd);

  // Absolute offsets (within the file) of template-literal quasi spans in
  // this body — the byte ranges de-indentation must never touch.
  const protectedSpans: Array<{ start: number; end: number }> = [];
  const collect = (node: ts.Node) => {
    if (
      ts.isNoSubstitutionTemplateLiteral(node) ||
      node.kind === ts.SyntaxKind.TemplateHead ||
      node.kind === ts.SyntaxKind.TemplateMiddle ||
      node.kind === ts.SyntaxKind.TemplateTail
    ) {
      protectedSpans.push({ start: node.getStart(sourceFile), end: node.getEnd() });
    }
    ts.forEachChild(node, collect);
  };
  collect(block);

  const lines = interior.split("\n");
  // Line start offsets in FILE coordinates, so they compare against spans.
  let offset = interiorStart;
  const lineStarts: number[] = [];
  for (const line of lines) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }
  const isProtected = (lineStart: number) =>
    protectedSpans.some((span) => lineStart > span.start && lineStart < span.end);

  const unprotected = lines.filter(
    (line, index) => line.trim() !== "" && !isProtected(lineStarts[index]!),
  );
  if (!unprotected.length) throw new Error(`example "${id}": fn body is empty`);
  const baseIndent = Math.min(...unprotected.map((line) => line.length - line.trimStart().length));

  const dedented = lines.map((line, index) => {
    if (line.trim() === "") return "";
    if (isProtected(lineStarts[index]!)) return line;
    return line.slice(baseIndent);
  });

  return dedented.join("\n").trim();
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  writeFileSync(outPath, generateItxExamples());
  console.log(`wrote ${outPath}`);
}
