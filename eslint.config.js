// @ts-check
import { tsImport } from "tsx/esm/api";
import js from "@eslint/js";
import typescript from "@typescript-eslint/eslint-plugin";
import typescriptParser from "@typescript-eslint/parser";
import eslintComments from "eslint-plugin-eslint-comments";
import importPlugin from "eslint-plugin-import";
import jsxA11y from "eslint-plugin-jsx-a11y";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import { defineConfig, globalIgnores } from "eslint/config";
import eslintRisky from "eslint/use-at-your-own-risk";
import globals from "globals";
import eslintPluginUnicorn from "eslint-plugin-unicorn";

/** @param {string} name */
const getBuiltinRule = (name) => {
  const rule = eslintRisky.builtinRules.get(name);
  if (!rule) throw new Error(`Builtin rule ${name} not found`);
  return rule;
};

/** @type {(typeof import("./vibe-rules/llms.ts"))} */
const { default: vibeRules } = await tsImport("./vibe-rules/llms.ts", import.meta.url);

export default defineConfig([
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  globalIgnores([
    "**/.cache/",
    "**/.corepack/",
    "**/.turbo/",
    "**/.claude/",
    "**/.cursor/",
    "**/.alchemy/",
    "**/components/ui/",
    "**/components/ai-elements/",
    "**/logs.json",
    "**/worker-configuration.d.ts",
    "**/routeTree.gen.ts",
    "**/db/migrations/",
    "**/*.d.ts",
    "**/node_modules/",
    "**/dist/",
    "**/build/",
    "pnpm-lock.yaml",
  ]),
  js.configs.recommended,
  // TypeScript/JavaScript files
  {
    files: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx", "**/*.mjs"],
    languageOptions: {
      parser: typescriptParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    plugins: {
      /** @type {{}} */
      "@typescript-eslint": typescript,
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
      /** @type {{}} */
      "jsx-a11y": jsxA11y,
      import: importPlugin,
      "eslint-comments": eslintComments,
    },
    rules: {
      // Core JavaScript rules
      "no-unused-vars": "off",
      "no-console": "off",
      "no-debugger": "error",
      "prefer-const": "off", // we're going to override this to be less annoying in IDEs
      "no-var": "error",
      "no-redeclare": "off",
      "no-undef": "off",
      "no-param-reassign": "off",

      // TypeScript rules (mapping from biome)
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          args: "all",
          argsIgnorePattern: "^_",
          caughtErrors: "all",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/prefer-literal-enum-member": "error",
      "@typescript-eslint/prefer-as-const": "error",
      "@typescript-eslint/prefer-enum-initializers": "error",
      "@typescript-eslint/no-inferrable-types": "error",
      "@typescript-eslint/no-redeclare": "off",
      "@typescript-eslint/consistent-type-imports": "off", // requires type info
      "@typescript-eslint/consistent-type-exports": "off", // requires type info
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/ban-types": "off",
      "@typescript-eslint/no-confusing-void-expression": "off",

      // Style rules (mapping from biome style rules)
      "prefer-exponentiation-operator": "error",
      "default-param-last": "error",
      "no-else-return": "off",
      "prefer-arrow-callback": "off",
      curly: "off",

      // Import rules
      "import/extensions": ["error", "ignorePackages"],
      "import/no-unresolved": "off", // TypeScript handles this
      "import/no-restricted-paths": "off",
      "import/order": "warn",

      // ESLint comments rules
      "eslint-comments/require-description": "error",

      // Complexity rules (mapping from biome complexity rules)
      "no-sequences": "error",
      "no-implied-eval": "error",
      radix: "off",
      "prefer-numeric-literals": "error",
      "no-new-func": "error",

      // React rules
      ...reactHooks.configs.recommended.rules,
      "react-hooks/exhaustive-deps": "warn",
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],

      // A11y rules (mapping from biome a11y rules)
      "jsx-a11y/click-events-have-key-events": "off",
      "jsx-a11y/no-noninteractive-element-to-interactive-role": "off",
    },
  },
  // Override for test files (mapping from biome overrides)
  {
    files: [
      "startups/**",
      "**/test/**",
      "**/*.test.ts",
      "**/*.test.tsx",
      "**/test-setup.ts",
      "**/test-utils.ts",
    ],
    rules: {
      "no-console": "off",
    },
  },
  { plugins: { unicorn: eslintPluginUnicorn } },
  {
    rules: {
      "unicorn/template-indent": "warn",
    },
  },
  {
    ignores: [".tmp-ci-build*"],
  },
  // Override for React Router route files
  {
    files: ["**/routes/**", "**/app/root.tsx"],
    rules: {
      "react-refresh/only-export-components": "off",
    },
  },
  // custom iterate-internal rules
  {
    name: "iterate-plugin",
    plugins: {
      iterate: {
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
              const acronyms = ["API", "HTML", "JSON", "TRPC", "MCP"];
              /** @param {string} actualName */
              function getExpectedName(actualName) {
                const acronymStart = acronyms.find(
                  (a) =>
                    actualName.toLowerCase().startsWith(a.toLowerCase()) &&
                    actualName[a.length]?.match(/[A-Z]/),
                );
                const capitaliseLetters = acronymStart ? acronymStart.length : 1;
                return (
                  actualName.slice(0, capitaliseLetters).toUpperCase() +
                  actualName.slice(capitaliseLetters).replace(/Schema$/, "")
                );
              }
              return {
                "VariableDeclarator[init.callee.object.name='z']": ({ id }) => {
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
          "prefer-const": fixToSuggestionInIDE(
            getBuiltinRule("prefer-const"),
            "Change to const, if you're finished tinkering",
          ),
          "side-effect-imports-first": {
            meta: {
              fixable: "code",
            },
            create: (context) => {
              return {
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
        },
      },
    },
  },
  { name: "ad-hoc ignorables", ignores: ["**/*ignoreme*"] },
  {
    name: "iterate-config",
    rules: {
      "iterate/prefer-const": "error",
      "iterate/side-effect-imports-first": "warn",
      "iterate/zod-schema-naming": "error",
    },
  },
  {
    name: "iterate-no-direct-waituntil",
    files: ["apps/os/**/*.ts", "apps/os/**/*.tsx"],
    rules: {
      "iterate/no-direct-waituntil-import": "error",
    },
  },
  ...vibeRules.flatMap((rule) => {
    if (!rule.eslint) return [];
    const { eslint, globs: files, name } = rule;
    return [{ name: `vibe-rules/${name}`, files, ...eslint }];
  }),
]);

/** @param {import("eslint").Rule.RuleModule} builtinRule */
function fixToSuggestionInIDE(builtinRule, desc = "Apply default fix") {
  /** @type {import("eslint").Rule.RuleModule} */
  const overridenRule = {
    ...builtinRule,
    meta: { ...builtinRule.meta, hasSuggestions: true },
    create: (context) => {
      if (!process.env.VSCODE_CWD) {
        return builtinRule.create(context); // use rule as-is outside of IDE
      }
      const proxyContext = new Proxy(new Object(), {
        get: (_target, prop) => {
          if (prop === "report") {
            /** @param {Parameters<typeof context.report>[0]} params */
            return ({ fix, ...params }) => {
              return context.report({ ...params, suggest: [{ desc, fix }] });
            };
          }
          return context[prop];
        },
      });
      // @ts-expect-error we're pretending this proxy context is the real context. We need to proxy because `context` sets its props as readonly so it's hard to shim
      return builtinRule.create(proxyContext);
    },
  };
  return overridenRule;
}
