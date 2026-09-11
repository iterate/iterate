// Reimplements the design from iterate/iterate#2491 (simple-truthiness-check).
// Adds direct-property checks and a dated rollout; uses types to leave numeric,
// boolean and unknown-input checks alone, and deliberately offers no autofix.
import { existsSync, readFileSync } from "node:fs";
import {
  ObjectFlags,
  SignatureKind,
  TypeFlags,
  type Type,
  type TypeReference,
  type UnionType,
} from "@typescript/native-preview/unstable/sync";
import type { Expression, Node } from "estree";
import { getTypeAwareLintService, type TypeAwareLintFileService } from "../oxlint-type-aware.ts";
import { grandfatherRule } from "../grandfather-rule.ts";

export const simpleTruthinessCheckRule = grandfatherRule({
  allowedUpTo: new Date("2026-09-11T00:00:00Z"),
  meta: {
    type: "suggestion",
    schema: [],
    docs: {
      description:
        "Prefer direct optional properties and trust types with simple truthiness checks.",
    },
  },
  create(context) {
    function isGlobal(node: Node, name: string) {
      let scope = context.sourceCode.getScope(node);
      while (scope) {
        if (scope.set.get(name)?.defs.length) return false;
        if (!scope.upper) break;
        scope = scope.upper;
      }
      return true;
    }
    function isNil(node: Node) {
      return (
        (node.type === "Identifier" && node.name === "undefined" && isGlobal(node, "undefined")) ||
        (node.type === "Literal" && node.value === null)
      );
    }
    function presenceOperand(node: Expression, absentArm: boolean) {
      if (node.type === "BinaryExpression") {
        if (!(absentArm ? ["==", "==="] : ["!=", "!=="]).includes(node.operator)) return undefined;
        if (isNil(node.right)) return node.left;
        if (isNil(node.left)) return node.right;
        return undefined;
      }
      return node;
    }
    const spreadGuards = new WeakSet<Node>();
    let file: TypeAwareLintFileService | undefined;
    function typeOf(node: Node) {
      if (!node.range) return undefined;
      if (!file) {
        const service = getTypeAwareLintService({ cwd: context.cwd });
        // Disk-backed files need no overlay: registering every file as changed
        // rebuilds TypeScript snapshots as oxlint walks the repository.
        if (
          service.textByFile.has(context.filename) ||
          !existsSync(context.filename) ||
          readFileSync(context.filename, "utf8") !== context.sourceCode.text
        ) {
          service.setFileText(context.filename, context.sourceCode.text);
        }
        file = service.getFileService(context.filename);
      }
      // The member's start points at its receiver (input), not its value (input.foo).
      const position = node.type === "MemberExpression" ? node.property.range?.[0] : node.range[0];
      if (typeof position !== "number") return undefined;
      return file?.getTypeAtPosition(position);
    }
    return {
      BinaryExpression(node) {
        if (!["==", "!=", "===", "!=="].includes(node.operator)) return;
        if (spreadGuards.has(node)) return;
        const unary =
          node.left.type === "UnaryExpression"
            ? node.left
            : node.right.type === "UnaryExpression"
              ? node.right
              : undefined;
        const literal = unary === node.left ? node.right : node.left;
        const value =
          unary?.operator === "typeof" &&
          literal.type === "Literal" &&
          ["undefined", "string", "object"].includes(String(literal.value))
            ? unary.argument
            : isNil(node.right)
              ? node.left
              : isNil(node.left)
                ? node.right
                : undefined;
        if (!value || !isReference(value)) return;
        const type = typeOf(value);
        if (!type || !isTruthyType(type)) return;
        if (unary && literal.type === "Literal" && literal.value !== "undefined") {
          const allowed =
            literal.value === "string"
              ? TypeFlags.StringLike
              : TypeFlags.Object | TypeFlags.NonPrimitive;
          if (!hasOnlyFlags(type, allowed | TypeFlags.Null | TypeFlags.Undefined)) return;
          if (literal.value === "object" && file) {
            // TypeScript groups functions and objects under Object, but typeof
            // distinguishes them. Check each union member before calling this redundant.
            const members = type.flags & TypeFlags.Union ? (type as UnionType).getTypes() : [type];
            const checker = file.project.checker;
            if (
              members.some(
                (member) =>
                  checker.getSignaturesOfType(member, SignatureKind.Call).length ||
                  checker.getSignaturesOfType(member, SignatureKind.Construct).length,
              )
            )
              return;
          }
        }
        context.report({
          node,
          message:
            "Trust the declared string/object type and use a truthiness check; prefer treating null, undefined and empty strings as absent. Explain any protocol that needs the distinction.",
        });
      },
      LogicalExpression(node) {
        if (node.operator !== "??" || !isReference(node.left)) return;
        const type = typeOf(node.left);
        if (!type || !isTruthyType(type)) return;
        context.report({
          node,
          message: "Use || for a string/object fallback so empty strings also get the default.",
        });
      },
      AssignmentExpression(node) {
        if (node.operator !== "??=" || !isReference(node.left)) return;
        const type = typeOf(node.left);
        if (!type || !isTruthyType(type)) return;
        context.report({
          node,
          message: "Use ||= for a string/object fallback so empty strings also get the default.",
        });
      },
      CallExpression(node) {
        if (
          node.callee.type !== "MemberExpression" ||
          node.callee.computed ||
          node.callee.object.type !== "Identifier" ||
          node.callee.object.name !== "Array" ||
          node.callee.property.type !== "Identifier" ||
          node.callee.property.name !== "isArray" ||
          node.arguments.length !== 1
        )
          return;
        if (!isGlobal(node, "Array")) return;
        const value = node.arguments[0];
        if (!isReference(value)) return;
        const type = typeOf(value);
        if (!type || !isArrayOrNil(type)) return;
        context.report({
          node,
          message:
            "This value is already an array when present. Trust its type and use a truthiness check.",
        });
      },
      "ObjectExpression > SpreadElement"(node) {
        const expression = node.argument;
        let guard: Expression;
        let object: Expression;
        if (expression.type === "LogicalExpression" && expression.operator === "&&") {
          guard = expression.left;
          object = expression.right;
        } else if (expression.type === "ConditionalExpression") {
          if (
            expression.alternate.type === "ObjectExpression" &&
            !expression.alternate.properties.length
          ) {
            guard = expression.test;
            object = expression.consequent;
          } else if (
            expression.consequent.type === "ObjectExpression" &&
            !expression.consequent.properties.length &&
            expression.test.type === "BinaryExpression" &&
            ["==", "==="].includes(expression.test.operator)
          ) {
            guard = expression.test;
            object = expression.alternate;
          } else return;
        } else return;
        if (object.type !== "ObjectExpression" || object.properties.length !== 1) return;
        const property = object.properties[0];
        if (
          property.type !== "Property" ||
          property.computed ||
          property.kind !== "init" ||
          property.method
        )
          return;
        const absentArm =
          expression.type === "ConditionalExpression" && object === expression.alternate;
        const value = presenceOperand(guard, absentArm);
        if (!value || !isReference(value) || !isReference(property.value)) return;
        if (context.sourceCode.getText(value) !== context.sourceCode.getText(property.value))
          return;
        spreadGuards.add(guard);
        context.report({
          node,
          message:
            "Write the property directly instead of conditionally omitting the same value. If omission has meaning, fix the receiving API or explain the protocol exception.",
        });
      },
    };
  },
});

function isReference(node: Node): boolean {
  return (
    node.type === "Identifier" ||
    (node.type === "MemberExpression" && !node.computed && isReference(node.object))
  );
}

function isTruthyType(type: Type) {
  return hasOnlyFlags(
    type,
    TypeFlags.StringLike |
      TypeFlags.Object |
      TypeFlags.NonPrimitive |
      TypeFlags.Null |
      TypeFlags.Undefined,
  );
}

function hasOnlyFlags(type: Type, flags: number): boolean {
  if (type.flags & TypeFlags.Union) {
    // The native API exposes union members through this flag-discriminated interface.
    return (type as UnionType).getTypes().every((member) => hasOnlyFlags(member, flags));
  }
  return Boolean(type.flags & flags);
}

function isArrayOrNil(type: Type): boolean {
  if (type.flags & TypeFlags.Union) {
    // Only unions expose getTypes in the native API.
    return (type as UnionType).getTypes().every(isArrayOrNil);
  }
  if (type.flags & (TypeFlags.Null | TypeFlags.Undefined)) return true;
  if (!(type.flags & TypeFlags.Object)) return false;
  // Object flags identify references; their target distinguishes tuples from other objects.
  const object = type as TypeReference;
  if (!(object.objectFlags & ObjectFlags.Reference)) return false;
  const name = object.getTarget().getSymbol()?.name;
  return (
    name === "Array" ||
    name === "ReadonlyArray" ||
    Boolean((object.getTarget() as TypeReference).objectFlags & ObjectFlags.Tuple)
  );
}
