import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

import esquery from "esquery";
import unicorn from "eslint-plugin-unicorn";
import type { Rule, Scope, SourceCode } from "eslint";
import type { Program } from "estree";

import { getPropertyName } from "./rules/ast.ts";
import { simpleTruthinessCheckRule } from "./rules/simple-truthiness-check.ts";
import { mechanicalClassImplRule } from "./rules/mechanical-class-impl.ts";
import { tseslintRules } from "./rules/tseslint.ts";
import type { StrictPlugin, StrictRule } from "./types.ts";

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
function isAllowedRawDurableObjectBindingAccessFile(filename: string) {
  const path = filename.replaceAll("\\", "/");

  if (!path.includes("/apps/os/src/")) return true;
  if (path.includes("/apps/os/docs/")) return true;
  // iterate-context.ts is THE capability layer: the edge's context handle and
  // the ItxEntrypoint loaded code reaches its context through.
  if (path.endsWith("/apps/os/src/iterate-context.ts")) return true;
  // The worker's edge entry points dial a context only after authorizing the caller:
  // project-host ingress (worker.ts), the MCP tool call (mcp.ts) and the OAuth
  // callback that lands a secret's tokens (secret-oauth-callback.ts).
  if (path.endsWith("/apps/os/src/worker.ts")) return true;
  if (path.endsWith("/apps/os/src/mcp.ts")) return true;
  if (path.endsWith("/apps/os/src/secret-oauth-callback.ts")) return true;

  return (
    path.includes("/durable-objects/") ||
    path.includes("/entrypoints/") ||
    path.endsWith("/durable-object.ts") ||
    path.endsWith("-durable-object.ts") ||
    // Entrypoint files (WorkerEntrypoints with zod-validated inputs) are
    // authority boundaries of the same standing as Durable Objects.
    path.endsWith("-entrypoint.ts") ||
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
/** Expression types that bind looser than `&&`, so they need wrapping parens
 * when placed on either side of it. `??` may not even mix with `&&`
 * unparenthesized (SyntaxError), and `a || b && c` / `f && a ? b : c` parse
 * with different groupings than the pre-fix code meant. */
function needsParensInsideLogicalAnd(node: any) {
  if (node.type === "LogicalExpression") return node.operator !== "&&";
  return (
    node.type === "ConditionalExpression" ||
    node.type === "AssignmentExpression" ||
    node.type === "ArrowFunctionExpression" ||
    node.type === "YieldExpression" ||
    node.type === "SequenceExpression"
  );
}

function isPlainLiteral(init: any) {
  if (init.type === "Literal") {
    return typeof init.value === "number" || typeof init.value === "string";
  }
  if (init.type === "TemplateLiteral") return init.expressions.length === 0;
  if (init.type === "UnaryExpression" && init.operator === "-") {
    return init.argument.type === "Literal" && typeof init.argument.value === "number";
  }
  return false;
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

const plugin: StrictPlugin = {
  meta: {
    name: "iterate",
  },
  rules: {
    "no-capnweb-http-batch": {
      meta: {
        docs: {
          description:
            "Prefer a capnweb WebSocket session over newHttpBatchRpcSession; bounded one-shot batches need a reasoned disable.",
        },
        type: "problem",
      },
      create: (context) => {
        const message =
          "Prefer newWebSocketRpcSession and dispose it when the call completes; a bounded one-shot HTTP batch needs a disable comment giving its reason.";
        // Calls and re-exports, not the import line: each batch is judged where it is made, and a
        // re-export (the SDK's) hands the constructor to code this rule cannot see.
        return {
          CallExpression: (node) => {
            if (node.callee.type === "Identifier" && node.callee.name === "newHttpBatchRpcSession")
              context.report({ node, message });
          },
          ExportSpecifier: (node) => {
            if (getPropertyName(node.local) === "newHttpBatchRpcSession")
              context.report({ node, message });
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
    "icon-button-has-hover-text": {
      meta: {
        docs: {
          description:
            "Require icon-size <Button>s to carry a title at the call site: it is their hover text, and " +
            "their accessible name when there is no aria-label. The vendored shadcn Button passes title " +
            "through and derives nothing (packages/ui/AGENTS.md). The off-the-shelf " +
            "jsx-a11y/control-has-associated-label rule can't do this: it assumes any " +
            "uppercase-component child (e.g. a lucide icon) might render a text label.",
        },
        type: "problem",
      },
      create: (context) => {
        return {
          JSXOpeningElement: (node: any) => {
            if (node.name.type !== "JSXIdentifier" || node.name.name !== "Button") return;
            // A spread might supply size and/or title; can't tell statically.
            if (node.attributes.some((attribute: any) => attribute.type !== "JSXAttribute")) return;

            const findAttribute = (name: string) =>
              node.attributes.find(
                (attribute: any) => getJSXAttributeName(attribute.name) === name,
              );
            const size = findAttribute("size")?.value;
            if (size?.type !== "Literal" || typeof size.value !== "string") return;
            if (!size.value.startsWith("icon")) return;

            const title = findAttribute("title")?.value;
            // Static string must be non-empty; assume any expression provides one.
            const hasTitle =
              title?.type === "Literal" ? Boolean(String(title.value).trim()) : title != null;
            if (hasTitle) return;
            context.report({
              node,
              message:
                `An icon-only <Button size="${size.value}"> has no visible text, so hovering users get ` +
                `nothing. Add title="..." (it is the accessible name too, unless aria-label differs).`,
            });
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
        type: "suggestion",
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
    "simple-truthiness-check": simpleTruthinessCheckRule,
    "prefer-logical-and-spread": {
      meta: {
        type: "suggestion",
        fixable: "code",
        docs: {
          description:
            "Prefer ...(cond && obj) over ...(cond ? obj : {}) in object literals. Object spread " +
            "treats any falsy value like {}, so the empty-object arm is dead weight.",
        },
      },
      create(context) {
        return {
          "ObjectExpression > SpreadElement > ConditionalExpression": (node: any) => {
            const { test, consequent, alternate } = node;
            if (alternate.type !== "ObjectExpression" || alternate.properties.length > 0) return;

            // Comments living inside the ternary but outside the parts we keep
            // (e.g. `f ? /* why */ {…} : {}`) would be dropped by the rewrite —
            // report without a fix in that case.
            const wouldDropComment = context.sourceCode.getAllComments().some((comment: any) => {
              if (!comment.range || !node.range) return false;
              const inside = (range: [number, number]) =>
                comment.range[0] >= range[0] && comment.range[1] <= range[1];
              return inside(node.range) && !inside(test.range) && !inside(consequent.range);
            });

            const wrap = (child: any) => {
              const text = context.sourceCode.getText(child);
              return needsParensInsideLogicalAnd(child) ? `(${text})` : text;
            };
            context.report({
              node,
              message:
                "Spreading a falsy value into an object literal is a no-op, same as spreading {}. " +
                "Use ...(cond && obj) instead of ...(cond ? obj : {}).",
              ...(!wouldDropComment && {
                fix: (fixer: Rule.RuleFixer) =>
                  fixer.replaceText(node, `${wrap(test)} && ${wrap(consequent)}`),
              }),
            });
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
    "no-shouting-constants": {
      meta: {
        type: "suggestion",
        docs: {
          description:
            "Flag module-scope SCREAMING_SNAKE consts that hold a plain literal and are read once. The literal belongs inline at its use site.",
        },
      },
      create(context) {
        return {
          VariableDeclarator(node) {
            // Oxlint supplies parent links beyond ESTree's declared node shape.
            const declaration = node.parent as any;
            if (declaration.type !== "VariableDeclaration" || declaration.kind !== "const") return;
            // Module scope only. `export const` has an ExportNamedDeclaration
            // parent, so exported consts fall out here too.
            if (declaration.parent?.type !== "Program") return;
            if (node.id.type !== "Identifier" || !node.init) return;
            if (!/^[A-Z][A-Z0-9_]+$/.test(node.id.name)) return;
            if (!isPlainLiteral(node.init)) return;
            // A JSDoc block right above is a written rationale for the name —
            // same escape hatch as no-single-use-helpers.
            if (hasLeadingJsDocComment(context.sourceCode, declaration)) return;

            const variable = findVariableInScopeChain(
              context.sourceCode.getScope(node),
              node.id.name,
            );
            if (!variable) return;
            const reads = variable.references.filter((ref: any) => ref.isRead());
            // `export { X }` / `export default X` make it part of the module's surface
            const isExportedReference = reads.some((ref: any) => {
              const parentType = ref.identifier.parent?.type;
              return parentType === "ExportSpecifier" || parentType === "ExportDefaultDeclaration";
            });
            if (isExportedReference) return;
            if (reads.length !== 1) return;

            context.report({
              node: node.id,
              message:
                `${node.id.name} is a SCREAMING_SNAKE constant holding a plain literal that is used once. ` +
                `Write the literal inline at its use site instead of naming it at module scope ` +
                `(expect(x).toBeLessThan(1_000_000), not const MAX_BYTES = 1_000_000).`,
            });
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
            if (isAllowedRawDurableObjectBindingAccessFile(context.filename || "")) return;

            context.report({
              node,
              message:
                `Raw env.${bindingName}.getByName(...) access is privileged platform authority. ` +
                `Untrusted ingress should go through the root capability/capability adapter instead. ` +
                `Allowed locations are Durable Objects, entrypoints, capability files, ` +
                `iterate-context.ts and the edge entry points (worker.ts, mcp.ts, secret-oauth-callback.ts).`,
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
    "spec-restricted-syntax": {
      meta: {
        type: "problem",
        docs: {
          description:
            "The Playwright spec house style (specs/AGENTS.md): locators over expect, no toBe(true/false), no waitForURL, no baseURL in goto",
        },
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
              // expect(locator).toBeVisible() / .toContainText() are
              // middlewright/prefer-locator-waits' territory (same verdict,
              // plus an autofix) — skip them so one mistake reports once.
              const matcher = node.parent;
              if (
                matcher?.type === "MemberExpression" &&
                matcher.property.type === "Identifier" &&
                (matcher.property.name === "toBeVisible" ||
                  matcher.property.name === "toContainText")
              ) {
                return;
              }
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
  },
};

export default plugin;
