import { resolve } from "node:path";

import type { Rule } from "eslint";
import type { CallExpression, Node } from "estree";
import type { Type } from "@typescript/native-preview/unstable/sync";

import {
  getTypeAwareLintService,
  type TypeAwareLintFileService,
  type TypeAwareLintService,
} from "../oxlint-type-aware.ts";
import type { StrictRule } from "../types.ts";

type Range = [number, number];
type CastNode = Node | CastExpression;
type CastExpression = Node & {
  expression: CastNode;
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
type CastRemovalCandidate = {
  replacedNode: CastExpression;
  replacedTypeText: string;
  replacementNode: CastNode;
  range: Range;
  text: string;
};
type CastRemoval = {
  candidate: CastRemovalCandidate;
  node: CastExpression;
};
type CastCheck = {
  affectedFiles?: readonly string[];
  candidates: CastRemovalCandidate[];
  node: CastExpression;
  projectScoped?: boolean;
};
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

    const sourceText = context.sourceCode.getText();
    const checks: CastCheck[] = [];
    let service: TypeAwareLintService | undefined;

    const getService = () => {
      if (!service) {
        service = getTypeAwareLintService();
        service.setFileText(filename, sourceText);
      }
      return service;
    };

    const listener = {
      TSAsExpression(node: CastExpression) {
        if (isCastExpression(node.parent)) return;
        checks.push({
          candidates: getCastRemovalCandidates(context, node),
          node,
        });
      },
      "Program:exit"() {
        if (checks.length === 0) return;
        const typeAwareService = getService();
        const fileService = typeAwareService.getFileService(filename);
        if (!fileService) return;

        const scopedChecks = checks.map((check) => ({
          ...check,
          projectScoped: requiresProjectDiagnostics(fileService, check.node),
        }));
        const provenRemovals = getTypeEquivalentCastRemovals(fileService, scopedChecks);
        const provenNodes = new Set(provenRemovals.map((removal) => removal.node));
        const remainingChecks = scopedChecks.filter((check) => !provenNodes.has(check.node));

        const fileScopedChecks = remainingChecks.filter((check) => !check.projectScoped);
        const projectScopedChecks = remainingChecks
          .filter((check) => check.projectScoped)
          .map((check) => ({
            ...check,
            affectedFiles: getProjectDiagnosticFiles(fileService, check.node),
          }));

        const checkedFileRemovals =
          fileScopedChecks.length === 0
            ? []
            : typeAwareService.withFileTextDiagnostics(filename, (getDiagnosticsForText) =>
                selectSafeCastRemovals({
                  baselineDiagnostics:
                    typeAwareService.getFileService(filename)?.getDiagnostics() || [],
                  checks: fileScopedChecks,
                  fixedCandidates: provenRemovals.map((removal) => removal.candidate),
                  fileName: filename,
                  sourceText,
                  getDiagnostics: (removals) => {
                    return getDiagnosticsForText(
                      applyTextReplacements(
                        sourceText,
                        [...provenRemovals, ...removals].map((removal) => removal.candidate),
                      ),
                    );
                  },
                }),
              );

        const targetedProjectChecks = projectScopedChecks.filter((check) => check.affectedFiles);
        const fullProjectChecks = projectScopedChecks.filter((check) => !check.affectedFiles);
        const locallySafeFullProjectRemovals =
          fullProjectChecks.length === 0
            ? []
            : typeAwareService.withFileTextDiagnostics(filename, (getDiagnosticsForText) =>
                selectSafeCastRemovals({
                  baselineDiagnostics:
                    typeAwareService.getFileService(filename)?.getDiagnostics() || [],
                  checks: fullProjectChecks,
                  fixedCandidates: [...provenRemovals, ...checkedFileRemovals].map(
                    (removal) => removal.candidate,
                  ),
                  fileName: filename,
                  sourceText,
                  getDiagnostics: (removals) => {
                    return getDiagnosticsForText(
                      applyTextReplacements(
                        sourceText,
                        [...provenRemovals, ...checkedFileRemovals, ...removals].map(
                          (removal) => removal.candidate,
                        ),
                      ),
                    );
                  },
                }),
              );
        const projectDiagnosticChecks = [
          ...targetedProjectChecks,
          ...locallySafeFullProjectRemovals.map((removal) => ({
            candidates: [removal.candidate],
            node: removal.node,
          })),
        ];

        const baselineDiagnostics =
          projectDiagnosticChecks.length > 0
            ? getProjectBaselineDiagnostics({
                checks: projectDiagnosticChecks,
                fileName: filename,
                typeAwareService,
              })
            : [];
        const checkedProjectRemovals =
          projectDiagnosticChecks.length === 0
            ? []
            : typeAwareService.withProjectDiagnosticsForFileText(
                filename,
                (getDiagnosticsForText) =>
                  selectSafeCastRemovals({
                    baselineDiagnostics,
                    checks: projectDiagnosticChecks,
                    fixedCandidates: [...provenRemovals, ...checkedFileRemovals].map(
                      (removal) => removal.candidate,
                    ),
                    fileName: filename,
                    sourceText,
                    getDiagnostics: (removals) => {
                      const replacements = [
                        ...provenRemovals,
                        ...checkedFileRemovals,
                        ...removals,
                      ].map((removal) => removal.candidate);
                      return getDiagnosticsForText(
                        applyTextReplacements(sourceText, replacements),
                        getAffectedFilesForRemovals(filename, projectDiagnosticChecks, removals),
                      );
                    },
                  }),
              );

        for (const removal of [
          ...provenRemovals,
          ...checkedFileRemovals,
          ...checkedProjectRemovals,
        ]) {
          context.report({
            node: removal.node,
            message: "Remove this cast; the project still type-checks without it.",
            fix: (fixer: Rule.RuleFixer) =>
              fixer.replaceTextRange(removal.candidate.range, removal.candidate.text),
          });
        }
      },
    };

    return listener;
  },
};

function getCastRemovalCandidates(
  context: Rule.RuleContext,
  node: CastExpression,
): CastRemovalCandidate[] {
  const sourceCode = context.sourceCode;

  const baseExpression = getBaseExpression(node);
  const candidates: CastRemovalCandidate[] = [];

  const baseRange = getRange(baseExpression);
  const expressionRange = getRange(node.expression);

  if (baseExpression !== node.expression && baseRange) {
    candidates.push({
      replacedNode: node,
      replacedTypeText: sourceCode.getText(node.typeAnnotation),
      replacementNode: baseExpression,
      range: node.range,
      text: sourceCode.getText(baseExpression),
    });
  }

  if (expressionRange) {
    candidates.push({
      replacedNode: node,
      replacedTypeText: sourceCode.getText(node.typeAnnotation),
      replacementNode: node.expression,
      range: node.range,
      text: sourceCode.getText(node.expression),
    });
  }

  if (isCastExpression(node.expression) && baseRange) {
    candidates.push({
      replacedNode: node.expression,
      replacedTypeText: sourceCode.getText(node.expression.typeAnnotation),
      replacementNode: baseExpression,
      range: node.expression.range,
      text: sourceCode.getText(baseExpression),
    });
  }

  return uniqueCandidates(candidates);
}

function getTypeEquivalentCastRemovals(fileService: TypeAwareLintFileService, checks: CastCheck[]) {
  return checks.flatMap((check) => {
    const candidate = check.candidates.find((candidate) =>
      hasStaticallySafeReplacementType(fileService, candidate, {
        projectScoped: Boolean(check.projectScoped),
      }),
    );
    return candidate ? [{ candidate, node: check.node }] : [];
  });
}

function hasStaticallySafeReplacementType(
  fileService: TypeAwareLintFileService,
  candidate: CastRemovalCandidate,
  scope: { projectScoped: boolean },
) {
  const replacedType = getCastExpressionType(
    fileService,
    candidate.replacedNode,
    candidate.replacedTypeText,
  );
  const replacementType = getCastNodeType(fileService, candidate.replacementNode);
  if (!replacedType || !replacementType) return false;
  if (fileService.isAnyType(replacementType)) return true;
  if (fileService.areTypesEquivalent(replacedType, replacementType)) return true;
  if (!scope.projectScoped && fileService.isTypeAssignableTo(replacementType, replacedType)) {
    return true;
  }

  const contextualType = getContextualTypeForCastReplacement(fileService, candidate.replacedNode);
  if (!contextualType) return false;
  if (!canUseContextualAssignmentProof(fileService, candidate.replacementNode, contextualType)) {
    return false;
  }
  return fileService.isTypeAssignableTo(replacementType, contextualType);
}

function getCastExpressionType(
  fileService: TypeAwareLintFileService,
  node: CastExpression,
  typeText?: string,
) {
  if (typeText?.trim() === "const") {
    return fileService.getTypeAtNodeLocation(node) || fileService.getTypeAtNodeStart(node);
  }

  const typeAnnotationRange = getRange(node.typeAnnotation);
  if (!typeAnnotationRange) return undefined;
  return (
    fileService.getTypeFromTypeNodeAtRange(typeAnnotationRange) ||
    (typeText ? fileService.getTypeFromSimpleTypeText(typeText, typeAnnotationRange[0]) : undefined)
  );
}

function getCastNodeType(fileService: TypeAwareLintFileService, node: CastNode) {
  if (isCastExpression(node)) return getCastExpressionType(fileService, node);
  return fileService.getTypeAtNodeLocation(node) || fileService.getTypeAtNodeStart(node);
}

function getContextualTypeForCastReplacement(
  fileService: TypeAwareLintFileService,
  node: CastExpression,
) {
  const nativeContextualType =
    fileService.getContextualTypeAtNodeLocation(node) ||
    fileService.getContextualTypeAtNodeLocation(node.expression);
  if (nativeContextualType) return nativeContextualType;

  const parent = looseNode(node.parent);
  if (!parent) return undefined;

  if (parent.type === "VariableDeclarator" && parent.init === node) {
    return getTypeAnnotationType(fileService, parent.id?.typeAnnotation);
  }

  if (
    (parent.type === "PropertyDefinition" || parent.type === "FieldDefinition") &&
    parent.value === node
  ) {
    return getTypeAnnotationType(fileService, parent.typeAnnotation);
  }

  if (parent.type === "AssignmentExpression" && parent.right === node) {
    return fileService.getTypeAtNodeStart(parent.left);
  }

  if (parent.type === "ReturnStatement" && parent.argument === node) {
    const fn = getParentFunction(parent);
    return getTypeAnnotationType(fileService, fn?.returnType || fn?.typeAnnotation);
  }

  if (parent.type === "CallExpression") {
    const argumentIndex = parent.arguments.indexOf(node);
    if (argumentIndex === -1) return undefined;
    return fileService.getCallParameterType(parent as CallExpression, argumentIndex);
  }

  return undefined;
}

function requiresProjectDiagnostics(fileService: TypeAwareLintFileService, node: CastExpression) {
  const variable = getParentVariableDeclarator(node);
  if (getTypeAnnotationRange(variable?.id?.typeAnnotation)) return false;

  const fn = getParentFunction(node);
  if (!fn) {
    return hasExternallyReferencedExportedDeclaration(fileService, node);
  }

  const topLevelStatement = getTopLevelStatement(fn);
  if (!isExportedStatement(topLevelStatement)) return false;
  if (!hasExternalReferences(fileService, getDeclarationIdentifierRange(fn))) return false;

  return !getTypeAnnotationRange(fn.returnType || fn.typeAnnotation);
}

function hasExternallyReferencedExportedDeclaration(
  fileService: TypeAwareLintFileService,
  node: CastExpression,
) {
  const range = getExportedDeclarationIdentifierRange(node);
  if (range === "unknown") return true;
  if (!range) return false;
  return hasExternalReferences(fileService, range);
}

function getProjectDiagnosticFiles(fileService: TypeAwareLintFileService, node: CastExpression) {
  const range = getExportedDeclarationIdentifierRange(node);
  if (range === "unknown") return undefined;
  if (!range) return undefined;
  return fileService.getExternalReferenceFilesAtRange(range);
}

function getExportedDeclarationIdentifierRange(node: CastExpression) {
  for (let current: LooseNode | undefined = looseNode(node); current; current = current.parent) {
    if (current.type === "Program") return undefined;

    if (current.type === "ExportDefaultDeclaration") return "unknown";

    if (current.type === "ExportNamedDeclaration") {
      const declaration = current.declaration;
      if (!declaration) return false;
      if (declaration.type === "VariableDeclaration") {
        const declarator = declaration.declarations.find((candidate: any) =>
          containsNode(candidate.init, node),
        );
        if (!declarator || getTypeAnnotationRange(declarator.id?.typeAnnotation)) return undefined;
        return getDeclarationIdentifierRange(declarator);
      }
      if (declaration.type === "FunctionDeclaration" || declaration.type === "ClassDeclaration") {
        return getDeclarationIdentifierRange(declaration);
      }
      return undefined;
    }
  }
  return undefined;
}

function hasExternalReferences(fileService: TypeAwareLintFileService, range: Range | undefined) {
  if (!range) return true;
  return fileService.hasExternalReferencesAtRange(range);
}

function getDeclarationIdentifierRange(node: any) {
  return getRange(node.id);
}

function getParentVariableDeclarator(node: { parent?: unknown }) {
  for (let current = looseNode(node.parent); current; current = current.parent) {
    if (current.type === "VariableDeclarator") return current;
    if (
      current.type === "FunctionDeclaration" ||
      current.type === "FunctionExpression" ||
      current.type === "ArrowFunctionExpression" ||
      current.type === "ClassDeclaration" ||
      current.type === "ClassExpression"
    ) {
      return undefined;
    }
  }
  return undefined;
}

function getTypeAnnotationType(
  fileService: TypeAwareLintFileService,
  typeAnnotation: { range?: Range } | undefined,
) {
  const range = getTypeAnnotationRange(typeAnnotation);
  if (!range) return undefined;
  return fileService.getTypeAtPosition(range[0] + 1);
}

function getTypeAnnotationRange(typeAnnotation: { range?: Range } | undefined) {
  return getRange(typeAnnotation) || getRange(looseNode(typeAnnotation)?.typeAnnotation);
}

function getParentFunction(node: { parent?: unknown }) {
  for (let current = looseNode(node.parent); current; current = current.parent) {
    if (
      current.type === "FunctionDeclaration" ||
      current.type === "FunctionExpression" ||
      current.type === "ArrowFunctionExpression"
    ) {
      return current;
    }
  }
  return undefined;
}

function getTopLevelStatement(node: { parent?: unknown }) {
  let current = looseNode(node);
  while (current?.parent && current.parent.type !== "Program") {
    current = current.parent;
  }
  return current;
}

function isExportedStatement(node: any) {
  return (
    node?.type === "ExportNamedDeclaration" ||
    node?.type === "ExportDefaultDeclaration" ||
    node?.parent?.type === "ExportNamedDeclaration" ||
    node?.parent?.type === "ExportDefaultDeclaration"
  );
}

function containsNode(container: { range?: Range } | undefined, node: { range?: Range }) {
  if (!container?.range || !node.range) return false;
  return container.range[0] <= node.range[0] && node.range[1] <= container.range[1];
}

function selectSafeCastRemovals(input: {
  baselineDiagnostics: readonly DiagnosticLike[];
  checks: CastCheck[];
  fileName: string;
  fixedCandidates: CastRemovalCandidate[];
  sourceText: string;
  getDiagnostics: (removals: CastRemoval[]) => readonly DiagnosticLike[];
}) {
  const baseline = new Set(
    input.baselineDiagnostics.map((diagnostic) => diagnosticSignature(diagnostic)),
  );
  const diagnosticsByReplacementKey = new Map<string, readonly DiagnosticLike[]>();
  const getNewDiagnostics = (removals: CastRemoval[]) => {
    const candidates = [...input.fixedCandidates, ...removals.map((removal) => removal.candidate)];
    const replacementKey = candidates.map(candidateKey).sort().join("\n");
    let diagnostics = diagnosticsByReplacementKey.get(replacementKey);
    if (!diagnostics) {
      diagnostics = input.getDiagnostics(removals);
      diagnosticsByReplacementKey.set(replacementKey, diagnostics);
    }
    return diagnostics
      .map((diagnostic) => normalizeDiagnostic(diagnostic, input.fileName, candidates))
      .filter((diagnostic) => !baseline.has(diagnosticSignature(diagnostic)));
  };
  const hasNoNewDiagnostics = (removals: CastRemoval[]) => getNewDiagnostics(removals).length === 0;

  const removals = input.checks
    .filter((check) => check.candidates.length > 0)
    .map((check) => ({
      candidate: check.candidates[0],
      node: check.node,
    }));
  const checkByNode = new Map(input.checks.map((check) => [check.node, check]));
  const selected: CastRemoval[] = [];
  selectSafeRemovalChunk(removals);
  return selected;

  function trySelectRemoval(
    removal: CastRemoval,
    options: { skipCandidate?: CastRemovalCandidate } = {},
  ) {
    const check = checkByNode.get(removal.node);
    if (!check) return false;
    for (const candidate of check.candidates) {
      if (candidate === options.skipCandidate) continue;
      const alternative = { candidate, node: check.node };
      if (!hasNoNewDiagnostics([...selected, alternative])) continue;
      selected.push(alternative);
      return true;
    }
    return false;
  }

  function selectSafeRemovalChunk(removalChunk: CastRemoval[]) {
    if (removalChunk.length === 0) return;
    const newDiagnostics = getNewDiagnostics([...selected, ...removalChunk]);
    if (newDiagnostics.length === 0) {
      selected.push(...removalChunk);
      return;
    }
    if (removalChunk.length === 1) {
      const [removal] = removalChunk;
      trySelectRemoval(removal, { skipCandidate: removal.candidate });
      return;
    }

    const suspects = removalChunk.filter((removal) =>
      newDiagnostics.some(
        (diagnostic) =>
          diagnosticOverlapsRemoval(diagnostic, removal, input.fileName) ||
          diagnosticReferencesRemovalVariable(diagnostic, removal, input.sourceText),
      ),
    );
    if (suspects.length > 0 && suspects.length < removalChunk.length) {
      const suspectNodes = new Set(suspects.map((removal) => removal.node));
      selectSafeRemovalChunk(removalChunk.filter((removal) => !suspectNodes.has(removal.node)));
      selectSafeRemovalChunk(suspects);
      return;
    }

    for (const removal of removalChunk) {
      trySelectRemoval(removal);
    }
  }
}

function diagnosticReferencesRemovalVariable(
  diagnostic: DiagnosticLike,
  removal: CastRemoval,
  sourceText: string,
) {
  const variableName = getRemovalVariableName(removal);
  if (!variableName) return false;
  return getMemberObjectNameBeforePosition(sourceText, diagnostic.pos) === variableName;
}

function getRemovalVariableName(removal: CastRemoval) {
  const variable = getParentVariableDeclarator(removal.candidate.replacedNode);
  if (!variable || variable.init !== removal.candidate.replacedNode) return undefined;
  return variable.id?.type === "Identifier" ? variable.id.name : undefined;
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

function diagnosticOverlapsRemoval(
  diagnostic: DiagnosticLike,
  removal: CastRemoval,
  fileName: string,
) {
  if (diagnostic.fileName && resolve(diagnostic.fileName) !== resolve(fileName)) return false;
  return rangesOverlap([diagnostic.pos, diagnostic.end], removal.candidate.range);
}

function getProjectBaselineDiagnostics(input: {
  checks: CastCheck[];
  fileName: string;
  typeAwareService: TypeAwareLintService;
}) {
  const affectedFiles = getAffectedFilesForChecks(input.fileName, input.checks);
  if (!affectedFiles) return input.typeAwareService.getProjectDiagnosticsForFile(input.fileName);
  return input.typeAwareService.getDiagnosticsForFiles(affectedFiles);
}

function getAffectedFilesForRemovals(
  fileName: string,
  checks: CastCheck[],
  removals: CastRemoval[],
) {
  const removalNodes = new Set(removals.map((removal) => removal.node));
  return getAffectedFilesForChecks(
    fileName,
    checks.filter((check) => removalNodes.has(check.node)),
  );
}

function getAffectedFilesForChecks(fileName: string, checks: CastCheck[]) {
  const affectedFiles = new Set([resolve(fileName)]);
  for (const check of checks) {
    if (!check.affectedFiles) return undefined;
    for (const affectedFile of check.affectedFiles) affectedFiles.add(resolve(affectedFile));
  }
  return [...affectedFiles].sort();
}

function diagnosticSignature(diagnostic: DiagnosticLike) {
  return [
    diagnostic.fileName || "",
    diagnostic.pos,
    diagnostic.end,
    diagnostic.code,
    diagnostic.text,
  ].join("\0");
}

function candidateKey(candidate: CastRemovalCandidate) {
  return `${candidate.range[0]}:${candidate.range[1]}:${candidate.text}`;
}

function normalizeDiagnostic(
  diagnostic: DiagnosticLike,
  fileName: string,
  candidates: CastRemovalCandidate[],
) {
  if (!diagnostic.fileName || resolve(diagnostic.fileName) !== resolve(fileName)) return diagnostic;

  return {
    ...diagnostic,
    end: mapEditedPositionToOriginal(diagnostic.end, candidates),
    pos: mapEditedPositionToOriginal(diagnostic.pos, candidates),
  };
}

function mapEditedPositionToOriginal(position: number, candidates: CastRemovalCandidate[]) {
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

function applyTextReplacements(sourceText: string, candidates: CastRemovalCandidate[]) {
  return [...candidates]
    .sort((left, right) => right.range[0] - left.range[0])
    .reduce(
      (text, candidate) =>
        text.slice(0, candidate.range[0]) + candidate.text + text.slice(candidate.range[1]),
      sourceText,
    );
}

function getBaseExpression(node: CastExpression): CastNode {
  let current: CastNode = node;
  while (isCastExpression(current)) {
    current = current.expression;
  }
  return current;
}

function uniqueCandidates(candidates: CastRemovalCandidate[]) {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.range[0]}:${candidate.range[1]}:${candidate.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function canUseContextualAssignmentProof(
  fileService: TypeAwareLintFileService,
  node: CastNode,
  contextualType: Type,
) {
  if (isCastExpression(node)) {
    const nestedContextualType =
      getContextualTypeForCastReplacement(fileService, node) || contextualType;
    return canUseContextualAssignmentProof(fileService, node.expression, nestedContextualType);
  }

  if (node.type === "ObjectExpression") {
    if (!objectLiteralKeysFitContextualType(fileService, node, contextualType)) return false;
  }

  for (const child of getChildNodes(node)) {
    if (child.type === "ObjectExpression" || child.type === "ArrayExpression") {
      const childContextualType = fileService.getContextualTypeAtNodeLocation(child);
      if (!childContextualType) return false;
      if (!canUseContextualAssignmentProof(fileService, child, childContextualType)) return false;
      continue;
    }
    if (!canUseContextualAssignmentProof(fileService, child, contextualType)) return false;
  }

  return true;
}

function objectLiteralKeysFitContextualType(
  fileService: TypeAwareLintFileService,
  node: Node,
  contextualType: Type,
) {
  const allowedNames = new Set(
    fileService.project.checker
      .getPropertiesOfType(contextualType)
      .map((property) => property.name),
  );
  const allowsStringKeys = fileService.project.checker
    .getIndexInfosOfType(contextualType)
    .some((info) => fileService.project.checker.typeToString(info.keyType) === "string");

  for (const property of looseNode(node)?.properties || []) {
    if (property.type === "SpreadElement") continue;
    if (property.computed) return false;
    const name = getStaticPropertyName(property.key);
    if (name === undefined) return false;
    if (!allowsStringKeys && !allowedNames.has(name)) return false;
  }

  return true;
}

function getStaticPropertyName(node: any) {
  if (node?.type === "Identifier") return node.name;
  if (
    node?.type === "Literal" &&
    (typeof node.value === "string" || typeof node.value === "number")
  ) {
    return String(node.value);
  }
  return undefined;
}

function getChildNodes(node: Node) {
  const children: Node[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent" || key === "range" || key === "loc") continue;
    if (!value) continue;
    if (Array.isArray(value)) {
      children.push(...value.filter(isNode));
      continue;
    }
    if (isNode(value)) children.push(value);
  }
  return children;
}

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && typeof looseNode(value)?.type === "string";
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
  return node as LooseNode;
}
