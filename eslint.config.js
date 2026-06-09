// TODO: rename this file to something like `oxlint-plugin-iterate.js` once this PR is merged
// (keeping the name `eslint.config.js` for now so git treats this as a rename+edit rather than delete+create)
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

import esquery from "esquery";
import unicorn from "eslint-plugin-unicorn";

const LIFECYCLE_HOOKS = new Set(["beforeAll", "beforeEach", "afterAll", "afterEach"]);
const VI_MOCK_CALLS = new Set(["vi.mock", "vi.doMock"]);
const PROPERTY_MATCHERS = new Set(["toBe", "toEqual", "toStrictEqual"]);
const STREAM_PROCESSOR_OVERRIDE_METHODS = new Set(["reduce", "processEvent", "processBatch"]);

/** @param {string} name */
const getExpectedName = (name) => {
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

/** @param {import("estree").MemberExpression | import("estree").Identifier | import("estree").CallExpression} callee */
const getCalleeName = (callee) => {
  if (callee.type === "Identifier") return callee.name;
  if (callee.type !== "MemberExpression") return null;
  if (callee.property.type === "Identifier") return callee.property.name;
  if (callee.property.type === "Literal" && typeof callee.property.value === "string") {
    return callee.property.value;
  }
  return null;
};

/** @param {import("estree").Node | undefined} node */
function getPropertyName(node) {
  if (!node) return undefined;
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  return undefined;
}

/** @param {import("estree").Node | undefined} node */
function getTestLintCallName(node) {
  if (!node) return undefined;
  if (node.type === "Identifier") return node.name;
  if (node.type !== "MemberExpression") return undefined;
  const objectName = getTestLintCallObjectName(node.object);
  const propertyName = getPropertyName(node.property);
  if (!objectName || !propertyName) return undefined;
  return `${objectName}.${propertyName}`;
}

/** @param {import("estree").Node} node */
function getTestLintCallObjectName(node) {
  if (node.type === "Identifier") return node.name;
  if (node.type === "MemberExpression") return getTestLintCallName(node);
  if (node.type === "CallExpression") return getTestLintCallName(node.callee);
  return undefined;
}

/** @param {import("estree").Node} callee */
function isDescribeCall(callee) {
  const name = getTestLintCallName(callee);
  return name === "describe" || Boolean(name?.startsWith("describe."));
}

/** @param {import("estree").Node} callee */
function isLifecycleHookCall(callee) {
  return callee.type === "Identifier" && LIFECYCLE_HOOKS.has(callee.name);
}

/** @param {import("estree").Node} callee */
function isViMockCall(callee) {
  const name = getTestLintCallName(callee);
  return Boolean(name && VI_MOCK_CALLS.has(name));
}

/** @param {import("estree").Node | undefined} node */
function isTestCallExpression(node) {
  if (!node || node.type !== "CallExpression") return false;
  const name = getTestLintCallName(node.callee);
  if (name === "test" || name === "it" || name?.startsWith("test.") || name?.startsWith("it.")) {
    return true;
  }
  return isTestCallExpression(node.callee);
}

/** @param {import("estree").Node} node */
function isFunctionLikeDeclaration(node) {
  if (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") return true;
  if (node.type !== "VariableDeclaration") return false;
  return node.declarations.some((declarator) => {
    const init = declarator.init;
    return (
      init &&
      (init.type === "FunctionExpression" ||
        init.type === "ArrowFunctionExpression" ||
        init.type === "ClassExpression")
    );
  });
}

/** @param {string} text */
function compactTypeText(text) {
  return text.replace(/\s+/g, "");
}

/**
 * @param {import("eslint").Rule.RuleContext} context
 * @param {import("estree").ClassDeclaration | import("estree").ClassExpression} node
 */
function getStreamProcessorContractType(context, node) {
  if (!node.superClass) return undefined;
  const classHeader = context.sourceCode.getText(node).slice(0, node.body.range?.[0] ?? undefined);
  const match = classHeader.match(/\bextends\s+StreamProcessor\s*<\s*([^,\n>]+)/);
  return match?.[1]?.trim();
}

/** @param {import("estree").Node} node */
function getClassElementName(node) {
  if (!("key" in node)) return undefined;
  return getPropertyName(node.key);
}

/** @param {import("estree").Node} parameter */
function getParameterTypeAnnotation(parameter) {
  if (!("typeAnnotation" in parameter)) return undefined;
  return parameter.typeAnnotation?.typeAnnotation;
}

const isolatedCodemodeRule = {
  ...unicorn.rules["isolated-functions"],
  create(context) {
    const original = unicorn.rules["isolated-functions"].create(context);
    for (const codemodeSelector of [":function[codemode]", ":function[codemode]:exit"]) {
      if (codemodeSelector in original) {
        const cb = original[codemodeSelector];
        delete original[codemodeSelector];
        const suffix = codemodeSelector.match(/:exit$/)?.[0] || "";
        const nonClashingCatchallFunctionSelector = `FunctionExpression[random!="${Math.random()}"]${suffix}`;
        original[nonClashingCatchallFunctionSelector] = (node, ...args) => {
          const parentCallee = node.parent?.callee;
          if (!parentCallee) return;
          if (!context.sourceCode.getText(parentCallee).match(/\bcodemode\b/i)) return;
          if (!context.sourceCode.getText(parentCallee).match(/\bfixture\b/i)) return;
          return cb(node, ...args);
        };
        original[`Arrow${nonClashingCatchallFunctionSelector}`] =
          original[nonClashingCatchallFunctionSelector];
      }
    }
    return original;
  },
};

/** @param {import("estree").CallExpression} node */
function getMatcherCall(node) {
  if (node.callee.type !== "MemberExpression") return undefined;
  const matcherName = getPropertyName(node.callee.property);
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

/**
 * @param {string} source
 * @param {string} filename
 */
function getRelativeTsImportWithExtension(source, filename) {
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

/**
 * @param {import("eslint").Rule.RuleContext} context
 * @param {import("estree").Literal} sourceNode
 */
function reportMissingRelativeImportExtension(context, sourceNode) {
  if (typeof sourceNode.value !== "string") return;

  const fixedSource = getRelativeTsImportWithExtension(sourceNode.value, context.filename || "");
  if (!fixedSource) return;

  context.report({
    node: sourceNode,
    message: `Use "${fixedSource}" instead of "${sourceNode.value}".`,
    fix: (fixer) => {
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
// oxlint jsPlugins requires a specific nesting structure for the default export
/** @type {{one: {two: {three: import("eslint").ESLint.Plugin}}}} */
const plugin = {
  one: {
    two: {
      three: {
        meta: {
          name: "iterate",
        },
        rules: {
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
                "VariableDeclarator[init.callee.object.name='z']": ({ init, id }) => {
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
                  (node) => {
                    const typeName = node.id.name;
                    const variableName =
                      node.typeAnnotation?.typeArguments?.params?.[0]?.exprName?.name;

                    if (variableName && variableName !== typeName) {
                      const expectedTypeName = getExpectedName(typeName);
                      const messages = [
                        typeName !== expectedTypeName &&
                          `rename the type alias to ${expectedTypeName}`,
                        variableName !== expectedTypeName &&
                          `rename the variable from ${variableName} to ${expectedTypeName}`,
                      ];
                      const suggestion =
                        messages.filter(Boolean).join(" and ") || "rename the variable";
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
                    if (!declarator.id || declarator.id.type !== "Identifier") continue;
                    if (!declarator.init) continue; // `let x;` without init is fine
                    const variable = scope.variables.find((v) => v.name === declarator.id.name);
                    if (!variable) continue;
                    const isReassigned = variable.references.some(
                      (ref) => ref.isWrite() && ref.identifier !== declarator.id,
                    );
                    if (isReassigned) continue;
                    context.report({
                      node: declarator.id,
                      message: `'${declarator.id.name}' is never reassigned. Use \`const\` instead.`,
                      suggest: [
                        {
                          desc: "Change to const, if you're finished tinkering",
                          fix: (fixer) => {
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
          "stream-processor-override-args": {
            meta: {
              type: "problem",
              docs: {
                description:
                  "StreamProcessor subclass override args must reference the base method parameter type.",
              },
            },
            create: (context) => {
              return {
                "ClassDeclaration, ClassExpression": (node) => {
                  const contractType = getStreamProcessorContractType(context, node);
                  if (!contractType) return;

                  for (const element of node.body.body) {
                    const methodName = getClassElementName(element);
                    if (methodName === "processEvents" || methodName === "processEventBatch") {
                      context.report({
                        node: element,
                        message: `Override processBatch, not ${methodName}: processEventBatch is the serialized public sink and must stay on the base class.`,
                      });
                      continue;
                    }

                    if (!methodName || !STREAM_PROCESSOR_OVERRIDE_METHODS.has(methodName)) {
                      continue;
                    }
                    if (element.type !== "MethodDefinition") continue;

                    const firstParameter = element.value.params[0];
                    const typeAnnotation = firstParameter
                      ? getParameterTypeAnnotation(firstParameter)
                      : undefined;
                    const actual =
                      typeAnnotation === undefined
                        ? undefined
                        : compactTypeText(context.sourceCode.getText(typeAnnotation));
                    const expected = compactTypeText(
                      `Parameters<StreamProcessor<${contractType}>["${methodName}"]>[0]`,
                    );

                    if (actual === expected) continue;

                    context.report({
                      node: firstParameter ?? element,
                      message: `Annotate ${methodName}'s args as \`Parameters<StreamProcessor<${contractType}>["${methodName}"]>[0]\`.`,
                    });
                  }
                },
              };
            },
          },
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
                TSImportType(node) {
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
                  if (!isLifecycleHookCall(node.callee)) return;
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
                  const parentBodyIndex = node.parent.body.indexOf(node);
                  const lastImportIndex = node.parent.body.findLastIndex(
                    (n) => n.type === "ImportDeclaration",
                  );
                  if (parentBodyIndex === -1 || parentBodyIndex !== lastImportIndex) {
                    return;
                  }
                  const exportsBefore = node.parent.body
                    .slice(0, parentBodyIndex)
                    .filter(
                      (n) =>
                        n.type === "ExportDeclaration" ||
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
                "ImportDeclaration[specifiers.length=0]": (node) => {
                  const parentBodyIndex = node.parent.body.indexOf(node);
                  const nonSideEffectImportBefore = node.parent.body
                    .slice(0, parentBodyIndex)
                    .find((n) => n.type === "ImportDeclaration" && n.specifiers.length);
                  if (!nonSideEffectImportBefore) {
                    return;
                  }
                  context.report({
                    node,
                    message: "Side-effect imports need to go before non-side-effect imports",
                    fix: (fixer) => {
                      return [
                        fixer.removeRange([node.range[0], node.range[1] + 1]),
                        fixer.insertTextBefore(
                          nonSideEffectImportBefore,
                          // @ts-expect-error getText exists I swear
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
                        (spec.type === "ImportSpecifier" && spec.imported.name === "waitUntil") ||
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
          "drizzle-conventions": {
            meta: {
              hasSuggestions: true,
              fixable: "code",
            },
            /** @param {import('eslint').Rule.RuleContext} context */
            create: (context) => {
              const dbMutateMethods = ["insert", "update", "delete"];
              /** @type {Record<string, Function>} */
              const dbMutateEnforcementListeners = {};
              for (const m of dbMutateMethods) {
                const selector = `CallExpression[callee.object.type='Identifier'][callee.property.name='${m}'][arguments.0.type='Identifier']`;
                const selector2 = `CallExpression[callee.object.type='Identifier'][callee.property.name='${m}'][arguments.0.object.name='schemas']`;
                dbMutateEnforcementListeners[selector] = (node) => {
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
                        fix: (fixer) => fixer.replaceText(node.arguments[0], after),
                      },
                    ],
                  });
                };
                dbMutateEnforcementListeners[selector2] = dbMutateEnforcementListeners[selector];
              }

              return {
                ...dbMutateEnforcementListeners,

                "CallExpression[callee.property.name='transaction']": (node) => {
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
                            fix: (fixer) => fixer.replaceText(m, shouldUse),
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
                    let expr = node;
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
                    (expression) =>
                      expression.type === "Identifier" && expression.name === "baseURL",
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
          /**
           * Contract packages (`apps/*-contract/src`) are imported by BOTH server
           * and client (browser) code. They must contain nothing but oRPC contract
           * definitions, Zod schemas, and lightweight client wiring. Pulling in
           * anything heavier — Node built-ins, OpenTelemetry, evlog, vite, the
           * shared barrel, etc. — breaks Vite production builds and bloats client
           * bundles.
           *
           * This rule enforces an explicit allowlist of permitted runtime import
           * sources. Type-only imports (`import type { … }`) are always fine
           * because they're erased at build time.
           *
           * Allowlist entries:
           * - `ALLOWED_RUNTIME_IMPORT_PREFIXES`: exact match or `pkg + "/..."` subpaths.
           * - `ALLOWED_RUNTIME_IMPORT_REGEX`: optional RegExp `source` strings (must match
           *   full specifier). Use only when a prefix is too broad.
           *
           * If you need to add a new package, verify it has ZERO transitive
           * Node/server deps, then add a prefix or regex below.
           */
          "contract-package-imports": {
            meta: {
              type: "problem",
              docs: {
                description:
                  "Restrict runtime imports in *-contract packages to a small allowlist of lightweight packages",
              },
            },
            create: (context) => {
              /** @type {string[]} */
              const ALLOWED_RUNTIME_IMPORT_PREFIXES = [
                "zod",
                "@orpc/contract",
                "@orpc/zod",
                "@iterate-com/shared/apps",
                "@orpc/client",
                "@orpc/openapi-client",
              ];
              /** @type {string[]} Full specifier must match (anchored in code). */
              const ALLOWED_RUNTIME_IMPORT_REGEX = [
                // OS's contract needs to share event-stream and codemode wire
                // schemas with the services that persist/execute those payloads.
                // These exact entrypoints are Zod schema modules on their runtime
                // paths; do not broaden to the package prefixes without checking
                // for Node/server transitive imports first.
                "@iterate-com/events-contract",
                // Events contract needs Callable payload schemas for browser-visible
                // wire types. This exact module is descriptor-only: Zod plus local
                // validation helpers, with no Worker/Node runtime authority.
                "@iterate-com/shared/callable/descriptor-types\\.ts",
                "@iterate-com/shared/codemode/types",
                "@iterate-com/shared/streams/types",
              ];
              const compiledRegex = ALLOWED_RUNTIME_IMPORT_REGEX.map(
                (pattern) => new RegExp(`^${pattern}$`),
              );

              /**
               * @param {string} source
               */
              function isAllowedRuntimeImport(source) {
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
                  if (node.importKind === "type") return;

                  const allSpecifiersTypeOnly =
                    node.specifiers.length > 0 &&
                    node.specifiers.every((s) => s.importKind === "type");
                  if (allSpecifiersTypeOnly) return;

                  const source = node.source.value;

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
                      `ALLOWED_RUNTIME_IMPORT_REGEX in eslint.config.js.`,
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
      },
    },
  },
};

export default plugin.one.two.three;
