import { resolve } from "node:path";

import type { Rule } from "eslint";
import type { Node, Program } from "estree";

import { getTypeAwareLintService } from "../oxlint-type-aware.ts";
import type { StrictRule } from "../types.ts";

type Range = [number, number];
type CastExpression = Node & {
  expression: Node | CastExpression;
  typeAnnotation: Node;
  parent?: unknown;
  range: Range;
};
type LooseNode = {
  [key: string]: any;
  parent?: LooseNode;
  range?: Range;
  type?: string;
};
type Candidate = { range: Range; text: string };
type Removal = {
  node: CastExpression;
  candidates: Candidate[];
  variableNames: string[];
  statementRange: Range;
};
type Selection = { removal: Removal; candidate: Candidate };
type DiagnosticLike = {
  code: number;
  end: number;
  fileName?: string;
  pos: number;
  text: string;
};

export const noPointlessCastsRule: StrictRule = {
  meta: {
    type: "problem",
    fixable: "code",
    schema: [],
    docs: {
      description: "Remove TypeScript `as` casts that do not affect type-checking.",
    },
  },
  create(context) {
    const filename = context.filename || "";
    if (!filename.endsWith(".ts") && !filename.endsWith(".tsx")) return {};

    const casts: CastExpression[] = [];

    return {
      TSAsExpression(node: CastExpression) {
        if (isCastExpression(looseNode(node)?.parent)) return;
        casts.push(node);
      },
      "Program:exit"() {
        if (casts.length === 0) return;
        for (const selection of selectVerifiedCastRemovals(context, filename, casts)) {
          context.report({
            node: selection.removal.node,
            message: "Remove this cast; the project still type-checks without it.",
            fix: (fixer: Rule.RuleFixer) =>
              fixer.replaceTextRange(selection.candidate.range, selection.candidate.text),
          });
        }
      },
    };
  },
};

// A cast is removable iff removing it produces no diagnostics in this file (in any project that
// compiles it) or in any file that can observe the removal through this file's exports — except
// casts of `any`-flavored expressions, which are load-bearing even though their removal
// type-checks. Rather than trying to predict removability with checker queries, apply the
// removals as an in-memory text overlay and re-run diagnostics: try all removals in one shot
// (the common case: everything is removable and one recheck settles it), and only on failure
// repair round by round, blaming diagnostics on specific removals and downgrading them to
// weaker candidates (e.g. `x as unknown as T` -> `x as T`) or dropping them.
function selectVerifiedCastRemovals(
  context: Rule.RuleContext,
  filename: string,
  casts: CastExpression[],
): Selection[] {
  const sourceText = context.sourceCode.getText();
  const service = getTypeAwareLintService();
  service.setFileText(filename, sourceText);
  const fileService = service.getFileService(filename);
  if (!fileService) return [];

  try {
    const declarations = collectTopLevelDeclarations(context.sourceCode.ast);
    const externalFiles = new Set<string>();
    const removals: Removal[] = [];
    // Only consider outermost casts: replacing `walk(x as A) as B` and `x as A` in the same text
    // would be overlapping edits. The inner cast gets flagged on a later run once the outer one
    // is gone.
    const outermostCasts = casts.filter(
      (cast) => !casts.some((other) => other !== cast && containsNode(other, cast)),
    );
    casts: for (const node of outermostCasts) {
      // A cast of an `any`-flavored expression (`res.json() as { source: string }`,
      // `JSON.parse(x) as Config`) type-checks without the cast too — but only because `any`
      // never errors. The cast is what pins the value to a real type; keep it.
      const baseRange = getRange(getBaseExpression(node));
      if (baseRange && fileService.isAnyLikeTypeAtRange(baseRange)) continue;
      if (!isCastSealedByAnnotation(node)) {
        const observerRanges = getExternalObserverRanges(node, declarations, sourceText);
        // undefined means we can't bound which files could observe the removal
        // (e.g. `export default` of the tainted value), so we conservatively keep the cast
        if (!observerRanges) continue;
        for (const observerRange of observerRanges) {
          // the file service memoizes find-references per range
          const referenceFiles = fileService.getExternalReferenceFilesAtRange(observerRange);
          if (!referenceFiles) continue casts;
          for (const referenceFile of referenceFiles) externalFiles.add(resolve(referenceFile));
        }
      }
      removals.push({
        node,
        candidates: getCastRemovalCandidates(context, node),
        variableNames: getEnclosingDeclarationNames(node),
        statementRange: getEnclosingStatementRange(node),
      });
    }
    if (removals.length === 0) return [];

    const fileNameOnly = [resolve(filename)];
    const allFileNames = [resolve(filename), ...externalFiles];
    const diagnosticsBySelectionKey = new Map<string, readonly DiagnosticLike[]>();
    // A type-check of this file costs tens of milliseconds, so a file full of unremovable casts
    // could burn seconds narrowing down exactly which ones are safe. Cap the attempts; casts we
    // never get to are conservatively kept.
    let remainingChecks = 24;

    // Any diagnostic at all counts against a removal — no baseline diffing. The repo is
    // expected to type-check cleanly, so a pre-existing error just means this file's casts are
    // conservatively kept until the error is fixed. Returns undefined when the check budget is
    // exhausted; positions are mapped back to sourceText coordinates for blame.
    const getNewDiagnostics = (
      selections: Selection[],
      fileNames: string[],
      options: { allProjects?: boolean } = {},
    ) => {
      const candidates = selections.map((selection) => selection.candidate);
      const selectionKey = [
        fileNames.length,
        Boolean(options.allProjects),
        ...candidates.map(candidateKey).sort(),
      ].join("\n");
      let diagnostics = diagnosticsBySelectionKey.get(selectionKey);
      if (!diagnostics) {
        if (remainingChecks <= 0) return undefined;
        remainingChecks--;
        service.setFileText(filename, applyTextReplacements(sourceText, candidates));
        diagnostics = service.getDiagnosticsForFiles(fileNames, options);
        diagnosticsBySelectionKey.set(selectionKey, diagnostics);
      }
      return diagnostics.map((diagnostic) => normalizeDiagnostic(diagnostic, filename, candidates));
    };

    // Repair in rounds, one check per round: blame each new diagnostic on a removal where
    // possible, downgrade the blamed removals to their next-weaker candidate (e.g.
    // `x as unknown as T` -> `x as T`) or drop them, and re-check. Returns only what the last
    // check actually proved safe.
    const repair = (
      initial: Selection[],
      firstDiagnostics: readonly DiagnosticLike[],
      fileNames: string[],
      options: { allProjects?: boolean },
    ) => {
      let active = initial;
      let newDiagnostics: readonly DiagnosticLike[] | undefined = firstDiagnostics;
      while (newDiagnostics && newDiagnostics.length > 0 && active.length > 0) {
        const roundDiagnostics = newDiagnostics;
        const blamed = new Set(
          roundDiagnostics.flatMap((diagnostic) => {
            const precise = active.filter((selection) =>
              blamesSelection(diagnostic, selection, filename, sourceText),
            );
            if (precise.length > 0) return precise;
            if (diagnosticIsInOtherFile(diagnostic, filename)) return [];
            // No removal directly implicated: blame every removal sharing the diagnostic's
            // statement (`for (const x of [...] as const)` erroring on a use of `x` in the loop
            // body), or whose declaration name appears on the diagnostic's line
            // (`provided.map((event) => event.payload.kind)` erroring far from the cast that
            // shaped `provided`). This can drop an innocent neighbor, but a fuzzy match beats
            // probing every removal individually.
            const diagnosticLine = getLineText(sourceText, diagnostic.pos);
            return active.filter(
              (selection) =>
                rangesOverlap([diagnostic.pos, diagnostic.end], selection.removal.statementRange) ||
                selection.removal.variableNames.some((name) =>
                  new RegExp(`\\b${name}\\b`).test(diagnosticLine),
                ),
            );
          }),
        );
        if (blamed.size > 0) {
          active = active.flatMap((selection) => {
            if (!blamed.has(selection)) return [selection];
            const nextCandidate =
              selection.removal.candidates[
                selection.removal.candidates.indexOf(selection.candidate) + 1
              ];
            return nextCandidate ? [{ removal: selection.removal, candidate: nextCandidate }] : [];
          });
        } else {
          // Nothing blamable (e.g. removing a mixin's constructor cast breaks `this.method()`
          // everywhere in the class): probe each removal individually and keep the ones that
          // are innocent alone, subject to the combined re-check each round.
          active = active.filter(
            (selection) => getNewDiagnostics([selection], fileNames, options)?.length === 0,
          );
        }
        newDiagnostics = active.length > 0 ? getNewDiagnostics(active, fileNames, options) : [];
        if (!newDiagnostics && active.length > 0) {
          // out of budget: pay for one last check so the file keeps its verified findings
          remainingChecks = 1;
          newDiagnostics = getNewDiagnostics(active, fileNames, options);
          break;
        }
      }
      return newDiagnostics?.length === 0 ? active : [];
    };

    const initial = removals.map((removal) => ({ removal, candidate: removal.candidates[0] }));

    // fast path, and the common case: every cast is removable, proven with one check of this
    // file (in every project that includes it) plus any files referencing exported casts
    const allNewDiagnostics = getNewDiagnostics(initial, allFileNames, { allProjects: true });
    if (allNewDiagnostics?.length === 0) return initial;
    if (!allNewDiagnostics) return [];

    // Something is load-bearing. Repair using cheap default-project checks of this file alone,
    // then re-verify the survivors with the strict multi-project check — and if that still
    // fails (e.g. a removal only breaks under another project's compiler options, or breaks a
    // referencing file), repair against the strict check directly.
    const selected = repair(initial, allNewDiagnostics, fileNameOnly, {});
    if (selected.length === 0) return [];
    remainingChecks = Math.max(remainingChecks, 4);
    const finalDiagnostics = getNewDiagnostics(selected, allFileNames, { allProjects: true });
    if (finalDiagnostics?.length === 0) return selected;
    if (!finalDiagnostics) return [];
    return repair(selected, finalDiagnostics, allFileNames, { allProjects: true });
  } finally {
    // Leave the service seeing the text oxlint linted; the flush happens lazily with the next
    // file's overlay, so the green path costs one snapshot update per file.
    service.setFileText(filename, sourceText);
  }
}

function getCastRemovalCandidates(context: Rule.RuleContext, node: CastExpression): Candidate[] {
  const sourceCode = context.sourceCode;
  const baseExpression = getBaseExpression(node);
  const candidates: Candidate[] = [];

  if (getRange(baseExpression)) {
    // remove the whole (possibly chained) cast: `x as unknown as T` -> `x`
    candidates.push({ range: node.range, text: sourceCode.getText(baseExpression) });
  }
  if (isCastExpression(node.expression)) {
    if (getRange(baseExpression)) {
      // collapse the chain: `x as unknown as T` -> `x as T`
      candidates.push({
        range: node.expression.range,
        text: sourceCode.getText(baseExpression),
      });
    }
    // drop the outer cast: `x as A as B` -> `x as A`; pointless when A is `unknown`/`any`
    const innerTypeText = sourceCode.getText(node.expression.typeAnnotation).trim();
    if (innerTypeText !== "unknown" && innerTypeText !== "any" && getRange(node.expression)) {
      candidates.push({ range: node.range, text: sourceCode.getText(node.expression) });
    }
  }

  return uniqueCandidates(candidates);
}

// Every named declaration the cast's value can flow out through: `const handle = (target) =>
// target as SomeShape` puts both any directly-initialized variable and `handle` here, since
// removing the cast changes what call sites like `handle(child).sdk` see.
function getEnclosingDeclarationNames(node: CastExpression) {
  const names: string[] = [];
  for (let current = looseNode(node)?.parent; current; current = current.parent) {
    if (current.type === "VariableDeclarator" && current.id?.type === "Identifier") {
      names.push(current.id.name);
    }
    if (current.type === "FunctionDeclaration" && current.id?.type === "Identifier") {
      names.push(current.id.name);
    }
    if (current.type === "PropertyDefinition" || current.type === "MethodDefinition") {
      if (current.key?.type === "Identifier") names.push(current.key.name);
    }
  }
  return names;
}

// Attribute a diagnostic to a removal: either it lands on the removed range itself, or it
// mentions the variable the cast initialized (`const person = raw as Person; person.name` errors
// at `person.name`, far from the cast).
function blamesSelection(
  diagnostic: DiagnosticLike,
  selection: Selection,
  fileName: string,
  sourceText: string,
) {
  // diagnostic positions only index into sourceText when the diagnostic is in this file
  if (diagnosticIsInOtherFile(diagnostic, fileName)) return false;
  if (rangesOverlap([diagnostic.pos, diagnostic.end], selection.candidate.range)) return true;
  if (selection.removal.variableNames.length === 0) return false;
  const diagnosticText = sourceText.slice(diagnostic.pos, diagnostic.end);
  const memberObjectName = getMemberObjectNameBeforePosition(sourceText, diagnostic.pos);
  return selection.removal.variableNames.some(
    (name) => memberObjectName === name || new RegExp(`\\b${name}\\b`).test(diagnosticText),
  );
}

function diagnosticIsInOtherFile(diagnostic: DiagnosticLike, fileName: string) {
  return Boolean(diagnostic.fileName) && resolve(diagnostic.fileName!) !== resolve(fileName);
}

function getLineText(sourceText: string, position: number) {
  const lineStart = sourceText.lastIndexOf("\n", position - 1) + 1;
  const lineEnd = sourceText.indexOf("\n", position);
  return sourceText.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
}

// The range a removal's type-check fallout usually lands in: the nearest enclosing statement,
// but never a whole enclosing function (a cast inside a 200-line `test(...)` callback should not
// absorb blame for the entire test).
function getEnclosingStatementRange(node: CastExpression): Range {
  let child = looseNode(node)!;
  for (let current = child.parent; current; child = current, current = current.parent) {
    if (
      current.type === "BlockStatement" ||
      current.type === "StaticBlock" ||
      current.type === "SwitchCase" ||
      current.type === "TSModuleBlock" ||
      current.type === "Program" ||
      current.type === "FunctionDeclaration" ||
      current.type === "FunctionExpression" ||
      current.type === "ArrowFunctionExpression"
    ) {
      break;
    }
  }
  return getRange(child) || node.range;
}

function getMemberObjectNameBeforePosition(sourceText: string, position: number) {
  let cursor = position;
  while (cursor > 0 && /\s/.test(sourceText[cursor - 1] || "")) cursor--;
  while (cursor > 0 && /[\w$]/.test(sourceText[cursor - 1] || "")) cursor--;
  while (cursor > 0 && /\s/.test(sourceText[cursor - 1] || "")) cursor--;
  if (sourceText[cursor - 1] !== ".") return undefined;
  cursor--;
  if (sourceText[cursor - 1] === "?") cursor--;
  while (cursor > 0 && /\s/.test(sourceText[cursor - 1] || "")) cursor--;

  const end = cursor;
  while (cursor > 0 && /[\w$]/.test(sourceText[cursor - 1] || "")) cursor--;
  const name = sourceText.slice(cursor, end);
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : undefined;
}

// Is there a type annotation between the cast and the module scope? An annotation fixes every
// type the rest of the module (and other files) can see, so the cast's removal can only produce
// diagnostics within this file.
function isCastSealedByAnnotation(node: CastExpression) {
  for (let current = looseNode(node)?.parent; current; current = current.parent) {
    switch (current.type) {
      case "VariableDeclarator":
        if (getTypeAnnotationRange(current.id?.typeAnnotation)) return true;
        break;
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        if (getTypeAnnotationRange(current.returnType || current.typeAnnotation)) return true;
        break;
      case "PropertyDefinition":
      case "FieldDefinition":
        if (getTypeAnnotationRange(current.typeAnnotation)) return true;
        break;
    }
  }
  return false;
}

type TopLevelDeclaration = {
  statement: LooseNode;
  names: string[];
  idRangesByName: Map<string, Range>;
  range: Range;
  // an annotation-sealed declaration's type cannot be changed by anything it references
  annotationSealed: boolean;
  exported: boolean;
  // exported in a way we can't trace to a single identifier (export default a non-identifier,
  // namespaces, ...): consumers can't be found via find-references
  unknownExport: boolean;
};

// The set of files that could observe an unsealed cast's removal. A cast's inferred type can
// flow through any chain of unannotated declarations in this file (`function helper() { return
// x as T } export function api() { return helper() }`), so taint the cast's own top-level
// declaration, propagate by name-mention to other unannotated declarations, and find-references
// on the exported ones. Returns undefined when the taint reaches an export we can't trace —
// callers should keep the cast.
function getExternalObserverRanges(
  node: CastExpression,
  declarations: TopLevelDeclaration[],
  sourceText: string,
): Range[] | undefined {
  const statement = getTopLevelStatement(node);
  const seed = declarations.find((declaration) => declaration.statement === statement);
  if (!seed) return []; // a top-level side-effect statement declares nothing others can observe
  const tainted = new Set<TopLevelDeclaration>([seed]);
  const taintedNames = new Set(seed.names);
  for (let grew = true; grew; ) {
    grew = false;
    for (const declaration of declarations) {
      if (tainted.has(declaration) || declaration.annotationSealed) continue;
      const body = sourceText.slice(declaration.range[0], declaration.range[1]);
      if (![...taintedNames].some((name) => new RegExp(`\\b${name}\\b`).test(body))) continue;
      tainted.add(declaration);
      for (const name of declaration.names) taintedNames.add(name);
      grew = true;
    }
  }

  const ranges: Range[] = [];
  for (const declaration of tainted) {
    if (declaration.unknownExport) return undefined;
    if (!declaration.exported) continue;
    for (const name of declaration.names) {
      const idRange = declaration.idRangesByName.get(name);
      if (!idRange) return undefined;
      ranges.push(idRange);
    }
  }
  return ranges;
}

function getTopLevelStatement(node: CastExpression) {
  let child = looseNode(node)!;
  for (let current = child.parent; current; child = current, current = current.parent) {
    if (current.type === "Program") return child;
  }
  return child;
}

function collectTopLevelDeclarations(program: Program): TopLevelDeclaration[] {
  const exportedNames = getExportSpecifierLocalNames(program);
  const declarations: TopLevelDeclaration[] = [];
  for (const statement of program.body) {
    const range = getRange(statement);
    if (!range) continue;
    const declaration = looseNode(
      statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration"
        ? statement.declaration
        : statement,
    );
    if (!declaration) continue;
    const exportedInline =
      statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration";

    const entry: TopLevelDeclaration = {
      statement,
      names: [],
      idRangesByName: new Map(),
      range,
      annotationSealed: false,
      exported: exportedInline,
      unknownExport: statement.type === "ExportDefaultDeclaration",
    };

    if (declaration.type === "VariableDeclaration") {
      entry.annotationSealed = declaration.declarations.every((declarator: LooseNode) =>
        getTypeAnnotationRange(declarator.id?.typeAnnotation),
      );
      for (const declarator of declaration.declarations) {
        for (const id of collectPatternIdentifiers(looseNode(declarator.id))) {
          entry.names.push(id.name);
          const idRange = getRange(id);
          if (idRange) entry.idRangesByName.set(id.name, idRange);
        }
      }
    } else if (
      declaration.type === "FunctionDeclaration" ||
      declaration.type === "ClassDeclaration" ||
      declaration.type === "TSTypeAliasDeclaration" ||
      declaration.type === "TSInterfaceDeclaration" ||
      declaration.type === "TSEnumDeclaration"
    ) {
      if (declaration.id?.type === "Identifier") {
        entry.names.push(declaration.id.name);
        const idRange = getRange(declaration.id);
        if (idRange) entry.idRangesByName.set(declaration.id.name, idRange);
      } else {
        entry.unknownExport = entry.exported;
      }
      if (declaration.type === "FunctionDeclaration") {
        entry.annotationSealed = Boolean(
          getTypeAnnotationRange(declaration.returnType || declaration.typeAnnotation),
        );
      }
    } else if (declaration.type === "TSModuleDeclaration") {
      entry.unknownExport = true;
    } else {
      continue; // side-effect statements etc. declare nothing others can observe
    }

    if (!entry.exported && entry.names.some((name) => exportedNames.has(name))) {
      entry.exported = true;
    }
    declarations.push(entry);
  }
  return declarations;
}

function getExportSpecifierLocalNames(program: Program) {
  const names = new Set<string>();
  for (const statement of program.body as LooseNode[]) {
    if (statement.type === "ExportNamedDeclaration" && !statement.declaration) {
      for (const specifier of statement.specifiers || []) {
        if (specifier.local?.type === "Identifier") names.add(specifier.local.name);
      }
    }
    if (
      statement.type === "ExportDefaultDeclaration" &&
      statement.declaration?.type === "Identifier"
    ) {
      names.add(statement.declaration.name);
    }
    if (statement.type === "TSExportAssignment" && statement.expression?.type === "Identifier") {
      names.add(statement.expression.name);
    }
  }
  return names;
}

function collectPatternIdentifiers(pattern: LooseNode | undefined): LooseNode[] {
  if (!pattern) return [];
  switch (pattern.type) {
    case "Identifier":
      return [pattern];
    case "ObjectPattern":
      return (pattern.properties || []).flatMap((property: LooseNode) =>
        collectPatternIdentifiers(looseNode(property.value || property.argument)),
      );
    case "ArrayPattern":
      return (pattern.elements || []).flatMap((element: LooseNode) =>
        collectPatternIdentifiers(looseNode(element)),
      );
    case "AssignmentPattern":
      return collectPatternIdentifiers(looseNode(pattern.left));
    case "RestElement":
      return collectPatternIdentifiers(looseNode(pattern.argument));
    default:
      return [];
  }
}

function containsNode(container: { range?: Range } | undefined, node: { range?: Range }) {
  if (!container?.range || !node.range) return false;
  return container.range[0] <= node.range[0] && node.range[1] <= container.range[1];
}

function candidateKey(candidate: Candidate) {
  return `${candidate.range[0]}:${candidate.range[1]}:${candidate.text}`;
}

function normalizeDiagnostic(
  diagnostic: DiagnosticLike,
  fileName: string,
  candidates: Candidate[],
) {
  if (!diagnostic.fileName || resolve(diagnostic.fileName) !== resolve(fileName)) return diagnostic;

  return {
    ...diagnostic,
    end: mapEditedPositionToOriginal(diagnostic.end, candidates),
    pos: mapEditedPositionToOriginal(diagnostic.pos, candidates),
  };
}

function mapEditedPositionToOriginal(position: number, candidates: Candidate[]) {
  let delta = 0;
  for (const candidate of [...candidates].sort((left, right) => left.range[0] - right.range[0])) {
    const editedStart = candidate.range[0] + delta;
    const editedEnd = editedStart + candidate.text.length;
    const originalLength = candidate.range[1] - candidate.range[0];

    if (position < editedStart) break;
    if (position <= editedEnd) return candidate.range[0];

    delta += candidate.text.length - originalLength;
  }
  return position - delta;
}

function rangesOverlap(left: Range, right: Range) {
  return left[0] <= right[1] && right[0] <= left[1];
}

function applyTextReplacements(sourceText: string, candidates: Candidate[]) {
  return [...candidates]
    .sort((left, right) => right.range[0] - left.range[0])
    .reduce(
      (text, candidate) =>
        text.slice(0, candidate.range[0]) + candidate.text + text.slice(candidate.range[1]),
      sourceText,
    );
}

function getBaseExpression(node: CastExpression): Node | CastExpression {
  let current: Node | CastExpression = node;
  while (isCastExpression(current)) {
    current = current.expression;
  }
  return current;
}

function uniqueCandidates(candidates: Candidate[]) {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = candidateKey(candidate);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function getTypeAnnotationRange(typeAnnotation: { range?: Range } | undefined) {
  return getRange(typeAnnotation) || getRange(looseNode(typeAnnotation)?.typeAnnotation);
}

function getRange(node: unknown): Range | undefined {
  const range = (node as { range?: unknown } | undefined)?.range;
  if (!Array.isArray(range)) return undefined;
  const [start, end] = range;
  if (typeof start !== "number" || typeof end !== "number") return undefined;
  return [start, end];
}

function isCastExpression(node: unknown): node is CastExpression {
  const candidate = looseNode(node);
  return candidate?.type === "TSAsExpression" && Boolean(getRange(candidate));
}

function looseNode(node: unknown): LooseNode | undefined {
  if (typeof node !== "object" || node === null) return undefined;
  return node;
}
