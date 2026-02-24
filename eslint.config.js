// TODO: rename this file to something like `oxlint-plugin-iterate.js` once this PR is merged
// (keeping the name `eslint.config.js` for now so git treats this as a rename+edit rather than delete+create)
import esquery from "esquery";

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
                      // @ts-expect-error -- lots of ?.
                      if (m.parent?.key?.name === "parent") return; // special case: outboxClient.send({ tx, parent: db }, '...', {...})
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
