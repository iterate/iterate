import type { Rule } from "eslint";
import type { Expression, Node } from "estree";

import { getTypeAwareLintService, type TypeAwareLintFileService } from "../oxlint-type-aware.ts";
import type { StrictRule } from "../types.ts";

export const tseslintRules: Record<string, StrictRule> = {
  "typed-no-floating-promises": {
    meta: {
      type: "problem",
      docs: {
        description:
          "Require promise-returning expression statements to be awaited, returned, or explicitly voided.",
      },
    },
    create(context) {
      const filename = context.filename || "";
      if (!filename.endsWith(".ts") && !filename.endsWith(".tsx")) return {};

      let fileService: TypeAwareLintFileService | undefined;

      return {
        CallExpression(node) {
          if (node.parent?.type !== "ExpressionStatement") return;
          if (isExplicitlyHandledPromiseExpression(node.parent.expression)) return;
          if (isPromiseHandlingCallExpression(node)) return;

          fileService ??= getPreparedTypeAwareLintFileService(context);
          if (!fileService) return;
          const thenable = fileService.getThenableInfo(node);
          if (!thenable) return;

          context.report({
            node,
            message:
              `Promise-like expression of type \`${truncateTypeText(thenable.text)}\` is not handled. ` +
              "Await it, return it, or explicitly mark it with `void`.",
          });
        },
      };
    },
  },
};

function getPreparedTypeAwareLintFileService(context: Rule.RuleContext) {
  const service = getTypeAwareLintService();
  service.setFileText(context.filename, context.sourceCode.getText());
  return service.getFileService(context.filename);
}

function isExplicitlyHandledPromiseExpression(expression: Expression) {
  if (expression.type === "AwaitExpression") return true;
  return expression.type === "UnaryExpression" && expression.operator === "void";
}

function isPromiseHandlingCallExpression(node: any) {
  if (node.callee.type !== "MemberExpression") return false;
  const propertyName = getPropertyName(node.callee.property);
  return propertyName === "catch" || propertyName === "then" || propertyName === "finally";
}

function getPropertyName(node: Node | undefined) {
  if (!node) return undefined;
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  return undefined;
}

function truncateTypeText(text: string) {
  const maxLength = 180;
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}
