import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

import esquery from "esquery";
import unicorn from "eslint-plugin-unicorn";
import type { Rule, Scope, SourceCode } from "eslint";
import type { Program, Node } from "estree";

import { mechanicalClassImplRule } from "./rules/mechanical-class-impl.ts";
import { noPointlessCastsRule } from "./rules/no-pointless-casts.ts";
import { tseslintRules } from "./rules/tseslint.ts";
import type { StrictPlugin, StrictRule } from "./types.ts";

type ImportKindNode = {
  importKind?: string;
};

const LIFECYCLE_HOOKS = new Set(["beforeAll", "beforeEach", "afterAll", "afterEach"]);
const VI_MOCK_CALLS = new Set(["vi.mock", "vi.doMock"]);
const PROPERTY_MATCHERS = new Set(["toBe", "toEqual", "toStrictEqual"]);
const getExpectedName = (name: string) => {
  const acronyms = ["API", "HTML", "JSON", "ORPC", "MCP"];
  const acronymStart = acronyms.find(
    (a) => name.toLowerCase().startsWith(a.toLowerCase()) && name[a.length]?.match(/[A-Z]/),
  );
  const capitaliseLetters = acronymStart ? acronymStart.length : 1;
  return (
    name.slice(0, capitaliseLetters).toUpperCase() +
    name.slice(capitaliseLetters).replace(/Schema$/, "")
  );
};
const getCalleeName = (callee: any) => {
  if (callee.type === "Identifier") return callee.name;
  if (callee.type !== "MemberExpression") return null;
  if (callee.property.type === "Identifier") return callee.property.name;
  if (callee.property.type === "Literal" && typeof callee.property.value === "string") {
    return callee.property.value;
  }
  return null;
};
function getPropertyName(node: Node | undefined) {
  if (!node) return undefined;
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  return undefined;
}
function isAllowedRawDurableObjectBindingAccessFile(filename: string) {
  const path = filename.replaceAll("\\", "/");

  if (!path.includes("/apps/os/src/")) return true;
  if (path.includes("/apps/os/docs/")) return true;
  if (path.includes("/apps/os/src/workers/")) return true;
  // src/itx is THE capability layer (apps/os/docs/itx-spec.md): the handle,
  // restorer, and egress entrypoint legitimately mint Project DO stubs.
  if (path.includes("/apps/os/src/itx/")) return true;
  if (path.includes("/apps/os/src/durable-objects/")) return true;
  if (!path.includes("/apps/os/src/domains/")) return false;

  return (
    path.includes("/durable-objects/") ||
    path.includes("/entrypoints/") ||
    path.endsWith("/durable-object.ts") ||
    path.endsWith("/capability.ts") ||
    path.endsWith("-capability.ts")
  );
}
function getRawEnvBindingName(node: any) {
  if (!node || node.type !== "MemberExpression") return undefined;
  const bindingName = getPropertyName(node.property);
  if (!bindingName) return undefined;
  if (node.object.type === "Identifier" && node.object.name === "env") return bindingName;
  if (
    node.object.type === "MemberExpression" &&
    getPropertyName(node.object.property) === "env" &&
    node.object.object.type === "ThisExpression"
  ) {
    return bindingName;
  }
  return undefined;
}
function getTestLintCallName(node: any): string | undefined {
  if (!node) return undefined;
  if (node.type === "Identifier") return node.name;
  if (node.type !== "MemberExpression") return undefined;
  const objectName = getTestLintCallObjectName(node.object);
  const propertyName = getPropertyName(node.property);
  if (!objectName || !propertyName) return undefined;
  return `${objectName}.${propertyName}`;
}
function getTestLintCallObjectName(node: any): string | undefined {
  if (node.type === "Identifier") return node.name;
  if (node.type === "MemberExpression") return getTestLintCallName(node);
  if (node.type === "CallExpression") return getTestLintCallName(node.callee);
  return undefined;
}
function isDescribeCall(callee: any) {
  const name = getTestLintCallName(callee);
  return name === "describe" || Boolean(name?.startsWith("describe."));
}
function isViMockCall(callee: any) {
  const name = getTestLintCallName(callee);
  return Boolean(name && VI_MOCK_CALLS.has(name));
}
function isTestCallExpression(node: any): boolean {
  if (!node || node.type !== "CallExpression") return false;
  const name = getTestLintCallName(node.callee);
  if (name === "test" || name === "it" || name?.startsWith("test.") || name?.startsWith("it.")) {
    return true;
  }
  return isTestCallExpression(node.callee);
}
function isFunctionLikeDeclaration(node: any) {
  if (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") return true;
  if (node.type !== "VariableDeclaration") return false;
  return node.declarations.some((declarator: any) => {
    const init = declarator.init;
    return (
      init &&
      (init.type === "FunctionExpression" ||
        init.type === "ArrowFunctionExpression" ||
        init.type === "ClassExpression")
    );
  });
}

function isFunctionExpressionNode(node: any) {
  return node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression";
}

function getExportWrapper(node: any) {
  if (
    node?.type === "ExportNamedDeclaration" ||
    node?.type === "ExportDefaultDeclaration" ||
    node?.type === "ExportAllDeclaration"
  ) {
    return node;
  }
  return undefined;
}

function getFunctionColocationStatement(node: any) {
  if (node.type === "FunctionDeclaration") {
    return getExportWrapper(node.parent) || node;
  }

  if (!isFunctionExpressionNode(node)) return undefined;

  const declarator = node.parent;
  if (declarator?.type !== "VariableDeclarator" || declarator.init !== node) return undefined;
  const declaration = declarator.parent;
  if (declaration?.type !== "VariableDeclaration") return undefined;
  return getExportWrapper(declaration.parent) || declaration;
}

function getTypeReferenceFunctionStatement(node: any) {
  for (let current = node.parent; current; current = current.parent) {
    if (current.type === "FunctionDeclaration") {
      return getFunctionColocationStatement(current);
    }
    if (isFunctionExpressionNode(current)) {
      const statement = getFunctionColocationStatement(current);
      if (statement) return statement;
    }
    if (
      current.type === "VariableDeclarator" &&
      current.init &&
      isFunctionExpressionNode(current.init)
    ) {
      return getFunctionColocationStatement(current.init);
    }
  }
  return undefined;
}

function isImmediatelyBeside(typeDeclaration: any, functionStatement: any) {
  const body = typeDeclaration.parent?.body;
  if (!Array.isArray(body) || body !== functionStatement.parent?.body) return false;

  const typeIndex = body.indexOf(typeDeclaration);
  const functionIndex = body.indexOf(functionStatement);
  if (typeIndex === -1 || functionIndex === -1) return false;

  const start = Math.min(typeIndex, functionIndex) + 1;
  const end = Math.max(typeIndex, functionIndex);
  const between = body.slice(start, end);
  return between.every(
    (statement) =>
      statement.type === "TSTypeAliasDeclaration" || statement.type === "TSInterfaceDeclaration",
  );
}

/**
 * Counts the source lines spanned by a function's body content: the statements between the
 * braces, or the expression of a concise arrow. Brace-only lines don't count, so
 * `function f() {\n  return x;\n}` is 1 line.
 *
 */
function getFunctionBodyLineCount(sourceCode: SourceCode, fn: any) {
  const body = fn.body;
  if (!body) return Infinity; // overload signatures / declare function
  let start;
  let end;
  if (body.type === "BlockStatement") {
    const statements = body.body;
    if (statements.length === 0) return 0;
    start = statements[0].range?.[0];
    end = statements[statements.length - 1].range?.[1];
  } else {
    start = body.range?.[0];
    end = body.range?.[1];
  }
  if (start === undefined || end === undefined) return Infinity;
  return sourceCode.getText().slice(start, end).split("\n").length;
}

function hasCommentInsideFunction(sourceCode: SourceCode, fn: any) {
  const bodyRange = fn.body?.range;
  if (!bodyRange) return false;

  return sourceCode.getAllComments().some((comment: any) => {
    if (!comment.range) return false;
    return comment.range[0] > bodyRange[0] && comment.range[1] < bodyRange[1];
  });
}

function hasLeadingJsDocComment(sourceCode: SourceCode, node: any) {
  const nodeStartLine = node.loc?.start.line;

  return sourceCode.getCommentsBefore(node).some((comment: any) => {
    if (comment.type !== "Block") return false;
    if (!comment.value.trim().startsWith("*")) return false;
    return !nodeStartLine || comment.loc?.end.line === nodeStartLine - 1;
  });
}

function hasCommentInRange(sourceCode: SourceCode, range: readonly [number, number] | undefined) {
  if (!range) return false;
  return sourceCode.getAllComments().some((comment) => {
    if (!comment.range) return false;
    return comment.range[0] >= range[0] && comment.range[1] <= range[1];
  });
}

function hasTypePredicateReturnType(sourceCode: SourceCode, fn: any) {
  const returnType = fn.returnType || fn.typeAnnotation;
  if (!returnType) return false;

  const returnTypeText = sourceCode.getText(returnType);
  return /\basserts\b/.test(returnTypeText) || /\bis\b/.test(returnTypeText);
}
function findVariableInScopeChain(scope: Scope.Scope | null, name: string) {
  for (let current = scope; current; current = current.upper) {
    const variable = current.variables.find((v: any) => v.name === name);
    if (variable) return variable;
  }
  return undefined;
}
function stringLiteralValue(node: any) {
  if (!node) return undefined;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  return undefined;
}

function getJSXAttributeName(attributeName: any) {
  if (!attributeName || typeof attributeName !== "object") return undefined;
  if (attributeName.type === "JSXIdentifier") return attributeName.name;
  if (attributeName.type === "JSXNamespacedName") {
    return `${attributeName.namespace.name}:${attributeName.name.name}`;
  }
  return undefined;
}

function hasSrOnlyClassToken(classText: string) {
  return classText.split(/\s+/).includes("sr-only");
}

function hasSrOnlyClassExpression(node: any): boolean {
  const literal = stringLiteralValue(node);
  if (literal !== undefined) return hasSrOnlyClassToken(literal);

  if (!node) return false;

  if (node.type === "TemplateLiteral") {
    return node.quasis.some((quasi: any) => hasSrOnlyClassToken(quasi.value.cooked || ""));
  }

  if (node.type === "ArrayExpression") {
    return node.elements.some((element: any) => hasSrOnlyClassExpression(element));
  }

  if (node.type === "ConditionalExpression") {
    return hasSrOnlyClassExpression(node.consequent) || hasSrOnlyClassExpression(node.alternate);
  }

  if (node.type === "LogicalExpression") {
    return hasSrOnlyClassExpression(node.left) || hasSrOnlyClassExpression(node.right);
  }

  if (node.type === "CallExpression") {
    return node.arguments.some((argument: any) => hasSrOnlyClassExpression(argument));
  }

  return false;
}

function jsxAttributeHasSrOnlyClass(attributeValue: any) {
  const literal = stringLiteralValue(attributeValue);
  if (literal !== undefined) return hasSrOnlyClassToken(literal);
  if (attributeValue?.type !== "JSXExpressionContainer") return false;
  return hasSrOnlyClassExpression(attributeValue.expression);
}

const isolatedCodemodeRule = {
  ...unicorn.rules?.["isolated-functions"],
  create(context) {
    const originalRule = unicorn.rules?.["isolated-functions"];
    if (!originalRule) return {};
    const original = originalRule.create(context as never);
    for (const codemodeSelector of [":function[codemode]", ":function[codemode]:exit"]) {
      if (codemodeSelector in original) {
        const cb = original[codemodeSelector];
        delete original[codemodeSelector];
        const suffix = codemodeSelector.match(/:exit$/)?.[0] || "";
        const nonClashingCatchallFunctionSelector = `FunctionExpression[random!="${Math.random()}"]${suffix}`;
        original[nonClashingCatchallFunctionSelector] = (node: any, ...args: any[]) => {
          const parentCallee = node.parent?.callee;
          if (!parentCallee) return;
          if (!context.sourceCode.getText(parentCallee).match(/\bcodemode\b/i)) return;
          if (!context.sourceCode.getText(parentCallee).match(/\bfixture\b/i)) return;
          return cb?.(node, ...args);
        };
        original[`Arrow${nonClashingCatchallFunctionSelector}`] =
          original[nonClashingCatchallFunctionSelector];
      }
    }
    return original;
  },
} as StrictRule;
function getMatcherCall(node: any) {
  if (node.callee.type !== "MemberExpression") return undefined;
  const matcherName = getPropertyName(node.callee.property);
  if (!matcherName) return undefined;
  if (!PROPERTY_MATCHERS.has(matcherName)) return undefined;

  let expectChain = node.callee.object;
  if (expectChain.type === "MemberExpression" && getPropertyName(expectChain.property) === "not") {
    expectChain = expectChain.object;
  }

  if (
    expectChain.type !== "CallExpression" ||
    expectChain.callee.type !== "Identifier" ||
    expectChain.callee.name !== "expect"
  ) {
    return undefined;
  }

  const actual = expectChain.arguments[0];
  if (!actual || actual.type !== "MemberExpression") return undefined;
  if (actual.computed) return undefined;

  const propertyName = getPropertyName(actual.property);
  if (propertyName === "length") return undefined;

  return { actual, matcherName };
}

function getRelativeTsImportWithExtension(source: string, filename: string) {
  if (!filename) return undefined;
  if (!source.startsWith("./") && !source.startsWith("../")) return undefined;

  const queryIndex = source.search(/[?#]/);
  const modulePath = queryIndex === -1 ? source : source.slice(0, queryIndex);
  const segments = modulePath.split("/");
  const lastSegment = segments[segments.length - 1] || "";
  if (!lastSegment || lastSegment.includes(".")) return undefined;

  const resolvedTsPath = resolve(dirname(filename), `${modulePath}.ts`);
  if (!existsSync(resolvedTsPath)) return undefined;

  return `${modulePath}.ts${queryIndex === -1 ? "" : source.slice(queryIndex)}`;
}

function inlinedTypeUseLineLength(sourceCode: SourceCode, identifier: any, inlineTypeText: string) {
  const line = identifier.loc?.start.line;
  if (!line) return Infinity;
  const sourceLine = sourceCode.lines[line - 1];
  if (!sourceLine) return Infinity;

  const startColumn = identifier.loc.start.column;
  const endColumn = identifier.loc.end.column;
  return `${sourceLine.slice(0, startColumn)}${inlineTypeText}${sourceLine.slice(endColumn)}`
    .length;
}

function reportMissingRelativeImportExtension(context: Rule.RuleContext, sourceNode: any) {
  if (typeof sourceNode.value !== "string") return;

  const fixedSource = getRelativeTsImportWithExtension(sourceNode.value, context.filename || "");
  if (!fixedSource) return;

  context.report({
    node: sourceNode,
    message: `Use "${fixedSource}" instead of "${sourceNode.value}".`,
    fix: (fixer: Rule.RuleFixer) => {
      const sourceText = context.sourceCode.getText(sourceNode);
      const quote = sourceText[0];
      const fixedSourceText =
        (quote === '"' || quote === "'") && sourceText.endsWith(quote)
          ? `${quote}${fixedSource}${quote}`
          : JSON.stringify(fixedSource);
      return fixer.replaceText(sourceNode, fixedSourceText);
    },
  });
}

// custom iterate-internal rules
const plugin: StrictPlugin = {
  meta: {
    name: "iterate",
  },
  rules: {
    "no-pointless-casts": noPointlessCastsRule,
    "no-capnweb-http-batch": {
      meta: {
        docs: {
          description:
            "Forbid capnweb's newHttpBatchRpcSession - always use a WebSocket session instead",
        },
        type: "problem",
      },
      create: (context) => {
        return {
          Identifier: (node) => {
            if (node.name === "newHttpBatchRpcSession") {
              context.report({
                node,
                message:
                  "Never use newHttpBatchRpcSession. Stateless workers can hold a WebSocket session for the duration of a request - use newWebSocketRpcSession and dispose it when the call completes.",
              });
            }
          },
        };
      },
    },
    "no-public-procedure": {
      meta: {
        docs: {
          description:
            "Warn against usage of publicProcedure - prefer flexibleAuthProcedure or other auth procedures",
        },
        type: "suggestion",
      },
      create: (context) => {
        return {
          Identifier: (node) => {
            if (node.name === "publicProcedure" && node.parent.type === "MemberExpression") {
              context.report({
                node,
                message:
                  "Avoid using publicProcedure unless the procedure truly must be publicly accessible - prefer one of the authenticated procedures instead",
              });
            }
          },
        };
      },
    },
    "no-sr-only-data-attributes": {
      meta: {
        docs: {
          description:
            "Forbid data-* attributes on sr-only elements; hidden test/data hooks should not masquerade as visible UI.",
        },
        type: "problem",
      },
      create: (context) => {
        return {
          JSXOpeningElement: (node: any) => {
            const attributes = node.attributes.filter(
              (attribute: any) => attribute.type === "JSXAttribute",
            );
            const classNameAttribute = attributes.find(
              (attribute: any) => getJSXAttributeName(attribute.name) === "className",
            );
            if (!jsxAttributeHasSrOnlyClass(classNameAttribute?.value)) return;

            for (const attribute of attributes) {
              const attributeName = getJSXAttributeName(attribute.name);
              if (!attributeName?.startsWith("data-")) continue;
              context.report({
                node: attribute,
                message:
                  `Do not put ${attributeName} on an sr-only element. ` +
                  `Use a visible wrapper for UI locators, or hidden/script JSON for machine-readable test data.`,
              });
            }
          },
        };
      },
    },
    "no-single-use-types": {
      meta: {
        type: "suggestion",
        docs: {
          description:
            "Flag non-exported single-use type aliases that can be inlined while keeping the use line under 100 columns.",
        },
      },
      create(context) {
        const MAX_INLINED_LINE_LENGTH = 99;

        return {
          TSTypeAliasDeclaration(node: any) {
            const parentType = node.parent?.type;
            if (
              parentType === "ExportNamedDeclaration" ||
              parentType === "ExportDefaultDeclaration"
            ) {
              return;
            }
            if (node.typeParameters) return;
            if (hasLeadingJsDocComment(context.sourceCode, node)) return;
            if (hasCommentInRange(context.sourceCode, node.typeAnnotation?.range)) return;

            const variable = findVariableInScopeChain(
              context.sourceCode.getScope(node),
              node.id.name,
            );
            if (!variable) return;

            const reads = variable.references.filter((ref) => ref.isRead());
            const readsInsideAlias = reads.some((ref) => {
              const referenceStart = ref.identifier.range?.[0];
              if (referenceStart === undefined || !node.range) return false;
              return referenceStart >= node.range[0] && referenceStart < node.range[1];
            });
            if (readsInsideAlias) return;

            const outsideAliasReads = reads.filter((ref) => {
              const referenceStart = ref.identifier.range?.[0];
              if (referenceStart === undefined || !node.range) return true;
              return referenceStart < node.range[0] || referenceStart >= node.range[1];
            });
            if (outsideAliasReads.length !== 1) return;

            const reference = outsideAliasReads[0];
            const referenceParentType = (reference.identifier as any).parent?.type;
            if (
              referenceParentType === "ExportSpecifier" ||
              referenceParentType === "ExportDefaultDeclaration"
            ) {
              return;
            }

            const inlineText = context.sourceCode
              .getText(node.typeAnnotation)
              .replaceAll(/\s+/g, " ")
              .trim();
            if (
              inlinedTypeUseLineLength(context.sourceCode, reference.identifier, inlineText) >
              MAX_INLINED_LINE_LENGTH
            ) {
              return;
            }

            context.report({
              node: node.id,
              message:
                `${node.id.name} is a non-exported single-use type alias that fits inline. ` +
                `Inline \`${inlineText}\` at its only use instead of keeping a separate type.`,
            });
          },
        };
      },
    },
    "zod-schema-naming": {
      meta: {
        docs: {
          description: `Zod schemas should be pascal case, and should not end with "Schema"`,
        },
        hasSuggestions: true,
        type: "suggestion",
        fixable: "code",
      },
      create: (context) => {
        return {
          "VariableDeclarator[init.callee.object.name='z']": (node) => {
            const { init, id } = node as any;
            if (init.callee.property.name === "toJSONSchema") return;
            if (init.callee.property.name === "prettifyError") return;

            const actualName = id.name;
            const expectedName = getExpectedName(actualName);

            if (actualName !== expectedName && actualName !== "schema") {
              context.report({
                node: id,
                message: `Rename zod schema ${actualName} to ${expectedName} or similar`,
                // disabled suggestion because you really need to do a IDE refactor to change all references
                // suggest: [{ desc: `Rename to ${expectedName}`, fix: fixer => fixer.replaceTextRange(id.range, expectedName) }]
              });
            }
          },
          "TSTypeAliasDeclaration[typeAnnotation.typeName.left.name='z'][typeAnnotation.typeName.right.name='infer']":
            (node: any) => {
              const typeName = node.id.name;
              const variableName = node.typeAnnotation?.typeArguments?.params?.[0]?.exprName?.name;

              if (variableName && variableName !== typeName) {
                const expectedTypeName = getExpectedName(typeName);
                const messages = [
                  typeName !== expectedTypeName && `rename the type alias to ${expectedTypeName}`,
                  variableName !== expectedTypeName &&
                    `rename the variable from ${variableName} to ${expectedTypeName}`,
                ];
                const suggestion = messages.filter(Boolean).join(" and ") || "rename the variable";
                context.report({
                  node,
                  message: `Type ${typeName} should be the z.infer result for a schema with the same name. Suggestion: ${suggestion}.`,
                });
              }
            },
        };
      },
    },
    // oxlint doesn't have fixToSuggestionInIDE, so we reimplement prefer-const as a suggestion-only rule.
    // this means `--fix` won't auto-convert let to const (you need `--fix-suggestions` for that).
    "prefer-const": {
      meta: {
        type: "suggestion",
        hasSuggestions: true,
        docs: {
          description:
            "Require `const` declarations for variables that are never reassigned after declared. Reported as a suggestion (not auto-fix) so it doesn't aggressively rewrite `let` while you're still writing code.",
        },
      },
      create: (context) => {
        return {
          VariableDeclaration: (node) => {
            if (node.kind !== "let") return;
            const scope = context.sourceCode.getScope(node);
            for (const declarator of node.declarations) {
              const id = declarator.id;
              if (!id || id.type !== "Identifier") continue;
              if (!declarator.init) continue; // `let x;` without init is fine
              const variable = scope.variables.find((v: any) => v.name === id.name);
              if (!variable) continue;
              const isReassigned = variable.references.some(
                (ref) => ref.isWrite() && ref.identifier !== id,
              );
              if (isReassigned) continue;
              context.report({
                node: id,
                message: `'${id.name}' is never reassigned. Use \`const\` instead.`,
                suggest: [
                  {
                    desc: "Change to const, if you're finished tinkering",
                    fix: (fixer: Rule.RuleFixer) => {
                      // Only fix if this is the only declarator — otherwise
                      // changing `let a = 1, b = 2` where only `a` is const is complex
                      if (node.declarations.length > 1) return null;
                      const letToken = context.sourceCode.getFirstToken(node);
                      if (!letToken || letToken.value !== "let") return null;
                      return fixer.replaceText(letToken, "const");
                    },
                  },
                ],
              });
            }
          },
        };
      },
    },
    ...tseslintRules,
    "mechanical-class-impl": mechanicalClassImplRule,
    "isolated-codemode": isolatedCodemodeRule,
    "relative-import-extensions": {
      meta: {
        type: "problem",
        fixable: "code",
        docs: {
          description:
            "Require .ts extensions on relative imports when the matching .ts file exists.",
        },
      },
      create(context) {
        return {
          ImportDeclaration(node) {
            reportMissingRelativeImportExtension(context, node.source);
          },
          ExportNamedDeclaration(node) {
            if (!node.source) return;
            reportMissingRelativeImportExtension(context, node.source);
          },
          ExportAllDeclaration(node) {
            reportMissingRelativeImportExtension(context, node.source);
          },
          ImportExpression(node) {
            if (node.source.type !== "Literal") return;
            reportMissingRelativeImportExtension(context, node.source);
          },
          TSImportType(node: any) {
            if (!node.argument) return;
            if (node.argument.type !== "Literal") return;
            reportMissingRelativeImportExtension(context, node.argument);
          },
        };
      },
    },
    "no-lifecycle-hooks": {
      meta: {
        type: "problem",
        docs: {
          description:
            "Disallow beforeEach/beforeAll/afterEach/afterAll in test files; use disposable fixtures instead.",
        },
      },
      create(context) {
        return {
          CallExpression(node) {
            if (node.callee.type !== "Identifier" || !LIFECYCLE_HOOKS.has(node.callee.name)) {
              return;
            }
            context.report({
              node,
              message:
                "Avoid Vitest lifecycle hooks in test files. Prefer fixtures with Symbol.dispose or Symbol.asyncDispose.",
            });
          },
        };
      },
    },
    "no-describe": {
      meta: {
        type: "suggestion",
        docs: {
          description:
            "Keep test files flat so the first readable unit is the test itself, not a describe wrapper.",
        },
      },
      create(context) {
        return {
          CallExpression(node) {
            if (!isDescribeCall(node.callee)) return;
            context.report({
              node,
              message:
                "Avoid describe blocks. Keep tests as top-level test(...) calls unless grouping is truly necessary.",
            });
          },
        };
      },
    },
    "no-vi-mock": {
      meta: {
        type: "suggestion",
        docs: {
          description:
            "Avoid vi.mock in tests; prefer dependency injection and controllable fakes at the product boundary.",
        },
      },
      create(context) {
        return {
          CallExpression(node) {
            if (!isViMockCall(node.callee)) return;
            context.report({
              node,
              message:
                "Avoid vi.mock/vi.doMock in tests. Prefer dependency injection or a controllable fake dependency.",
            });
          },
        };
      },
    },
    "no-single-use-helpers": {
      meta: {
        type: "suggestion",
        docs: {
          description:
            "Flag undocumented tiny non-exported helper functions that are only used once. Inline them so the reader can see what's actually happening instead of chasing an indirection.",
        },
      },
      create(context) {
        const MAX_BODY_LINES = 1;

        function checkHelper(id: any, fn: any, statement: any) {
          const exportParent = statement.parent?.type;
          if (
            exportParent === "ExportNamedDeclaration" ||
            exportParent === "ExportDefaultDeclaration"
          ) {
            return;
          }

          const bodyLines = getFunctionBodyLineCount(context.sourceCode, fn);
          if (bodyLines > MAX_BODY_LINES) return;
          if (
            statement.type === "VariableDeclaration" &&
            (statement.kind === "let" || statement.kind === "var")
          ) {
            return;
          }
          if (esquery.match(fn, esquery.parse("IfStatement")).length > 0) return;
          if (hasLeadingJsDocComment(context.sourceCode, statement)) return;
          if (hasCommentInsideFunction(context.sourceCode, fn)) return;
          if (hasTypePredicateReturnType(context.sourceCode, fn)) return;

          const scope = context.sourceCode.getScope(statement);
          const variable = findVariableInScopeChain(scope, id.name);
          if (!variable) return;

          const reads = variable.references.filter((ref: any) => ref.isRead());
          // `export { helper }` / `export default helper` make it part of the module's surface
          const isExportedReference = reads.some((ref: any) => {
            const parentType = ref.identifier.parent?.type;
            return parentType === "ExportSpecifier" || parentType === "ExportDefaultDeclaration";
          });
          if (isExportedReference) return;

          // a recursive helper can't be inlined, so any self-reference disqualifies it
          const hasSelfReference = reads.some((ref: any) => {
            const referenceStart = ref.identifier.range?.[0];
            if (referenceStart === undefined || !fn.range) return false;
            return referenceStart >= fn.range[0] && referenceStart < fn.range[1];
          });
          if (hasSelfReference) return;
          if (reads.length !== 1) return;

          context.report({
            node: id,
            message:
              `${id.name} is a single-use helper with a ${bodyLines}-line body. ` +
              `Inline it at the call site so the reader can see what's actually happening.`,
          });
        }

        return {
          FunctionDeclaration(node) {
            if (!node.id) return;
            checkHelper(node.id, node, node);
          },
          VariableDeclarator(node) {
            if (node.id.type !== "Identifier" || !node.init) return;
            if (
              node.init.type !== "ArrowFunctionExpression" &&
              node.init.type !== "FunctionExpression"
            ) {
              return;
            }
            checkHelper(node.id, node.init, node.parent);
          },
        };
      },
    },
    "colocate-single-use-types": {
      meta: {
        type: "suggestion",
        docs: {
          description:
            "Require non-exported single-use type aliases and interfaces to sit immediately beside the function they serve.",
        },
      },
      create(context) {
        function checkTypeDeclaration(node: any) {
          const typeName = node.id?.name;
          if (!typeName) return;
          if (node.declare) return;
          if (getExportWrapper(node.parent)) return;

          const scope = context.sourceCode.getScope(node);
          const variable = findVariableInScopeChain(scope, typeName);
          if (!variable) return;

          const reads = variable.references.filter((ref) => ref.isRead());
          const isExportedReference = reads.some((ref) => {
            const parentType = (ref.identifier as any).parent?.type;
            return parentType === "ExportSpecifier" || parentType === "ExportDefaultDeclaration";
          });
          if (isExportedReference) return;
          if (reads.length !== 1) return;

          const functionStatement = getTypeReferenceFunctionStatement(reads[0].identifier);
          if (!functionStatement) return;
          if (isImmediatelyBeside(node, functionStatement)) return;

          context.report({
            node: node.id,
            message:
              `${typeName} is a non-exported type used by one function. ` +
              `Move it immediately before or immediately after that function.`,
          });
        }

        return {
          "TSTypeAliasDeclaration, TSInterfaceDeclaration": checkTypeDeclaration,
        };
      },
    },
    "helpers-after-tests": {
      meta: {
        type: "suggestion",
        docs: {
          description:
            "Keep helper functions and fixture builders below the top-level tests in each test file.",
        },
      },
      create(context) {
        return {
          Program(node) {
            const lastTestIndex = node.body.findLastIndex((statement) => {
              return (
                statement.type === "ExpressionStatement" &&
                isTestCallExpression(statement.expression)
              );
            });
            if (lastTestIndex === -1) return;

            for (const statement of node.body.slice(0, lastTestIndex)) {
              if (!isFunctionLikeDeclaration(statement)) continue;
              context.report({
                node: statement,
                message:
                  "Move test helpers below the tests so the file opens with behavior, not setup.",
              });
            }
          },
        };
      },
    },
    "prefer-object-property-match": {
      meta: {
        type: "suggestion",
        docs: {
          description:
            "Prefer expect(object).toMatchObject({ property }) over expect(object.property).toBe(...).",
        },
      },
      create(context) {
        return {
          CallExpression(node) {
            const matcherCall = getMatcherCall(node);
            if (!matcherCall) return;

            const propertyName = getPropertyName(matcherCall.actual.property);
            const sourceText = context.sourceCode.getText(matcherCall.actual.object);
            const propertyText = propertyName ? `.${propertyName}` : ".[property]";
            context.report({
              node,
              message:
                `Prefer expect(${sourceText}).toMatchObject({ ${propertyName || "property"}: ... }) ` +
                `over expect(${sourceText}${propertyText}).${matcherCall.matcherName}(...).`,
            });
          },
        };
      },
    },
    "prefer-test-over-it": {
      meta: {
        type: "suggestion",
        docs: {
          description: "Use Vitest test(...) instead of it(...).",
        },
      },
      create(context) {
        return {
          ImportSpecifier(node) {
            if (node.imported.type !== "Identifier" || node.imported.name !== "it") return;
            context.report({
              node,
              message: 'Import and use `test` from "vitest" instead of `it`.',
            });
          },
          CallExpression(node) {
            const name = getTestLintCallName(node.callee);
            if (name !== "it" && !name?.startsWith("it.")) return;
            context.report({
              node,
              message: "Use test(...) instead of it(...).",
            });
          },
        };
      },
    },
    "import-rules": {
      meta: {
        fixable: "code",
      },
      create: (context) => {
        return {
          ImportDeclaration: (node) => {
            const parentBody = (node.parent as Program).body;
            const parentBodyIndex = parentBody.indexOf(node);
            const lastImportIndex = parentBody.findLastIndex((n) => n.type === "ImportDeclaration");
            if (parentBodyIndex === -1 || parentBodyIndex !== lastImportIndex) {
              return;
            }
            const exportsBefore = parentBody
              .slice(0, parentBodyIndex)
              .filter(
                (n) =>
                  n.type === "ExportNamedDeclaration" ||
                  n.type === "ExportAllDeclaration" ||
                  n.type === "ExportDefaultDeclaration",
              );

            exportsBefore.forEach((e) => {
              context.report({
                node: e,
                message: `Exports should come after imports`,
              });
            });
          },
          "ImportDeclaration[specifiers.length=0]": (node: any) => {
            const parentBody = (node.parent as Program).body;
            const parentBodyIndex = parentBody.indexOf(node as any);
            const nonSideEffectImportBefore = parentBody
              .slice(0, parentBodyIndex)
              .find((n) => n.type === "ImportDeclaration" && n.specifiers.length);
            if (!nonSideEffectImportBefore) {
              return;
            }
            context.report({
              node,
              message: "Side-effect imports need to go before non-side-effect imports",
              fix: (fixer: Rule.RuleFixer) => {
                return [
                  fixer.removeRange([node.range[0], node.range[1] + 1]),
                  fixer.insertTextBefore(
                    nonSideEffectImportBefore,
                    `${context.sourceCode.getText(node)}\n`,
                  ),
                ];
              },
            });
          },
        };
      },
    },
    "no-direct-waituntil-import": {
      meta: {
        docs: {
          description:
            "Disallow importing waitUntil directly from cloudflare:workers - use the wrapper from env.ts instead",
        },
        type: "problem",
      },
      create: (context) => {
        return {
          ImportDeclaration: (node) => {
            if (node.source.value === "cloudflare:workers") {
              const waitUntilImport = node.specifiers.find(
                (spec) =>
                  (spec.type === "ImportSpecifier" &&
                    getPropertyName(spec.imported) === "waitUntil") ||
                  spec.type === "ImportNamespaceSpecifier",
              );
              if (waitUntilImport) {
                context.report({
                  node: waitUntilImport,
                  message:
                    'Do not import waitUntil directly from "cloudflare:workers". Use the error-handling wrapper from "../env.ts" instead: import { waitUntil } from "../env.ts"',
                });
              }
            }
          },
        };
      },
    },
    "no-raw-durable-object-binding-access": {
      meta: {
        type: "problem",
        docs: {
          description:
            "Restrict raw env.*.getByName Durable Object namespace access to capability adapters and trusted domain internals.",
        },
      },
      create: (context) => {
        return {
          "CallExpression[callee.type='MemberExpression']": (node: any) => {
            if (getPropertyName(node.callee.property) !== "getByName") return;
            const bindingName = getRawEnvBindingName(node.callee.object);
            if (!bindingName) return;
            if (isAllowedRawDurableObjectBindingAccessFile(context.filename ?? "")) return;

            context.report({
              node,
              message:
                `Raw env.${bindingName}.getByName(...) access is privileged platform authority. ` +
                `Untrusted ingress should go through the root capability/capability adapter instead. ` +
                `Allowed locations are domain Durable Objects, domain entrypoints, capability files, ` +
                `and the current Cap'n Web compatibility layer.`,
            });
          },
        };
      },
    },
    "drizzle-conventions": {
      meta: {
        hasSuggestions: true,
        fixable: "code",
      },
      create: (context) => {
        const dbMutateMethods = ["insert", "update", "delete"];
        const dbMutateEnforcementListeners: Record<string, (node: any) => void> = {};
        for (const m of dbMutateMethods) {
          const selector = `CallExpression[callee.object.type='Identifier'][callee.property.name='${m}'][arguments.0.type='Identifier']`;
          const selector2 = `CallExpression[callee.object.type='Identifier'][callee.property.name='${m}'][arguments.0.object.name='schemas']`;
          dbMutateEnforcementListeners[selector] = (node: any) => {
            const before = context.sourceCode.getText(node.arguments[0]);
            const after = before.startsWith("schemas.")
              ? before.replace("schemas.", "schema.")
              : `schema.${node.arguments[0].name}`;
            if (
              (m === "delete" || m === "update") &&
              node.callee.object.name !== "db" &&
              node.callee.object.name !== "tx"
            ) {
              return; // too many false positives for Maps, hmac.update, etc.
            }
            context.report({
              node: node.arguments[0],
              message: `use \`db.${m}(${after})\` instead of \`db.${m}(${before})\` - it makes it easier to find ${m} expressions in the codebase`,
              suggest: [
                {
                  desc: `Change \`${before}\` to \`${after}\``,
                  fix: (fixer: Rule.RuleFixer) => fixer.replaceText(node.arguments[0], after),
                },
              ],
            });
          };
          dbMutateEnforcementListeners[selector2] = dbMutateEnforcementListeners[selector];
        }

        return {
          ...dbMutateEnforcementListeners,

          "CallExpression[callee.property.name='transaction']": (node: any) => {
            const parentReference = context.sourceCode.getText(node.callee.object);
            const shouldUse = node.arguments[0].params[0]?.name;
            esquery.match(node, esquery.parse(`${node.callee.object.type}`)).forEach((m) => {
              const used = context.sourceCode.getText(m);
              if (m !== node.callee.object && parentReference === used) {
                context.report({
                  node: m,
                  message: `Don't use the parent connection (${used}) in a transaction. Use the passed in transaction connection (${shouldUse}).`,
                  suggest: [
                    {
                      desc: `Change \`${used}\` to \`${shouldUse}\``,
                      fix: (fixer: Rule.RuleFixer) => fixer.replaceText(m, shouldUse),
                    },
                  ],
                });
              }
            });
          },
        };
      },
    },
    "spec-restricted-syntax": {
      meta: {
        type: "problem",
      },
      create: (context) => {
        return {
          CallExpression: (node) => {
            if (node.callee.type === "Identifier" && node.callee.name === "expect") {
              let expr: any = node;
              while ((expr = expr.parent)) {
                if (expr.type === "AwaitExpression") break;
              }
              if (!expr) return;
              context.report({
                node,
                message: `Use locators, not expect. Locators are configured to wait for loading UI to complete, so allow for faster failures and more reliable assertions. For example: page.getByText("...").waitFor() instead of expect(page.getByText("...")).toBeVisible(). If you can't use a locator and must use polling, expect.poll is acceptable.`,
              });
              return;
            }

            if (
              node.callee.type === "MemberExpression" &&
              node.callee.property.type === "Identifier" &&
              node.callee.property.name === "toBe"
            ) {
              const firstArg = node.arguments[0];
              if (
                firstArg &&
                firstArg.type === "Literal" &&
                (firstArg.value === true || firstArg.value === false)
              ) {
                context.report({
                  node,
                  message: `Don't use toBe(true) or toBe(false), this is an indicator of an assertion that will fail unhelpfully. Examples: use \`await expect.poll(() => realtimeMessages).toMatchObject(expect.arrayContaining([expect.stringContaining("CONNECTED")]));\` instead of \`await expect.poll(() => realtimeMessages.some((msg) => msg.includes("CONNECTED"))).toBe(true);\`.`,
                });
                return;
              }
            }

            const calleeName = getCalleeName(node.callee);
            if (calleeName === "waitForURL") {
              context.report({
                node,
                message: `Don't use waitForURL, use a locator with .waitFor() instead, this accounts for loading UI. If necessary, you can add "data-*" attributes to the product code so you have a concrete, reliable locator.`,
              });
              return;
            }

            if (calleeName !== "goto") {
              return;
            }
            const firstArg = node.arguments[0];
            if (firstArg?.type !== "TemplateLiteral") {
              return;
            }
            const usesBaseUrl = firstArg.expressions.some(
              (expression) => expression.type === "Identifier" && expression.name === "baseURL",
            );
            if (!usesBaseUrl) {
              return;
            }
            context.report({
              node,
              message: `Don't use baseURL in goto, it's added as a prefix automatically. e.g. instead of \`await page.goto(\`\${baseURL}/foo/bar}\`)\`, use \`await page.goto("/foo/bar")\``,
            });
          },
        };
      },
    },
    "contract-package-imports": {
      meta: {
        type: "problem",
        docs: {
          description:
            "Restrict runtime imports in *-contract packages to a small allowlist of lightweight packages",
        },
      },
      create: (context) => {
        const ALLOWED_RUNTIME_IMPORT_PREFIXES = [
          "zod",
          "@orpc/contract",
          "@orpc/zod",
          "@iterate-com/shared/apps",
          "@orpc/client",
          "@orpc/openapi-client",
        ];
        const ALLOWED_RUNTIME_IMPORT_REGEX = [
          // OS's contract needs to share event-stream and codemode wire
          // schemas with the services that persist/execute those payloads.
          // These exact entrypoints are Zod schema modules on their runtime
          // paths; do not broaden to the package prefixes without checking
          // for Node/server transitive imports first.
          "@iterate-com/shared/callable/descriptor-types\\.ts",
          "@iterate-com/shared/codemode/types",
          "@iterate-com/shared/streams/types",
        ];
        const compiledRegex = ALLOWED_RUNTIME_IMPORT_REGEX.map(
          (pattern) => new RegExp(`^${pattern}$`),
        );

        function isAllowedRuntimeImport(source: string) {
          if (
            ALLOWED_RUNTIME_IMPORT_PREFIXES.some(
              (pkg) => source === pkg || source.startsWith(pkg + "/"),
            )
          ) {
            return true;
          }
          return compiledRegex.some((re) => re.test(source));
        }

        const filename = context.filename ?? "";
        const isTestFile = /\.(test|spec)\.[cm]?[jt]sx?$/.test(filename);

        const allowedListForMessage =
          ALLOWED_RUNTIME_IMPORT_PREFIXES.map((p) => `  • ${p} (and ${p}/…)`).join("\n") +
          (ALLOWED_RUNTIME_IMPORT_REGEX.length > 0
            ? "\n\n" + ALLOWED_RUNTIME_IMPORT_REGEX.map((p) => `  • /^${p}$/`).join("\n")
            : "");

        return {
          ImportDeclaration: (node) => {
            if (isTestFile) return;
            if ((node as ImportKindNode).importKind === "type") return;

            const allSpecifiersTypeOnly =
              node.specifiers.length > 0 &&
              node.specifiers.every((s) => (s as ImportKindNode).importKind === "type");
            if (allSpecifiersTypeOnly) return;

            const source = node.source.value;
            if (typeof source !== "string") return;

            if (source.startsWith(".") || source.startsWith("/")) return;

            if (isAllowedRuntimeImport(source)) return;

            context.report({
              node,
              message:
                `Forbidden runtime import "${source}" in a contract package.\n\n` +
                `Contract packages are imported by both server and browser code, so they ` +
                `must stay ultra-light. Only these runtime imports are allowed:\n\n` +
                allowedListForMessage +
                `\n\nRelative imports and \`import type\` are always fine.\n` +
                `If "${source}" is genuinely lightweight (zero Node/server deps), add a ` +
                `prefix to ALLOWED_RUNTIME_IMPORT_PREFIXES or a pattern to ` +
                `ALLOWED_RUNTIME_IMPORT_REGEX in oxlint-plugin-iterate.ts.`,
            });
          },
        };
      },
    },
    "no-implied-eval": {
      meta: {
        type: "problem",
      },
      create: (context) => {
        return {
          CallExpression: (node) => {
            const calleeName = getCalleeName(node.callee);
            if (
              calleeName !== "setTimeout" &&
              calleeName !== "setInterval" &&
              calleeName !== "execScript"
            ) {
              return;
            }

            const firstArg = node.arguments[0];
            if (!firstArg) {
              return;
            }

            const isStringLiteral =
              firstArg.type === "Literal" && typeof firstArg.value === "string";
            const isTemplateLiteral = firstArg.type === "TemplateLiteral";
            if (!isStringLiteral && !isTemplateLiteral) {
              return;
            }

            context.report({
              node: firstArg,
              message: "Implied eval. Pass a function instead of a string.",
            });
          },
        };
      },
    },
  },
};

export default plugin;
