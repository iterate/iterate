// iterate/no-inferable-type-annotation (no-inferable-type-annotation.md): `const x: Foo = makeFoo()`
// where TypeScript infers Foo anyway. Oxlint's @typescript-eslint/no-inferrable-types already
// covers literals (`const n: number = 1`); this rule asks the checker about other initializers.
import type { Node } from "estree";
import {
  getTokenAtPosition,
  isCallOrNewExpression,
  isPropertyDeclaration,
  isVariableDeclaration,
  type CallOrNewExpression,
  type Node as TsNode,
} from "typescript/unstable/ast";
import { TypeFlags } from "typescript/unstable/sync";

import {
  getTypeAwareLintFileService,
  type TypeAwareLintFileService,
} from "../oxlint-type-aware.ts";
import type { StrictRule } from "../types.ts";

/**
 * Reports a variable or class property whose annotation is the very type its initializer already
 * has. The checker types an initializer against the annotation (its contextual type), so the rule
 * only trusts initializers whose type no contextual type can change: references, member reads,
 * `as` and `satisfies`, JSX, `null`, and calls whose signature infers no type arguments. A literal,
 * object, array or function initializer is left alone: its type can depend on the annotation.
 */
export const noInferableTypeAnnotationRule: StrictRule = {
  meta: {
    type: "suggestion",
    fixable: "code",
    schema: [],
    messages: {
      inferable:
        "TypeScript infers `{{type}}` from the initializer, so this annotation repeats it. Drop the annotation.",
    },
    docs: {
      description: "Disallow type annotations that repeat the type TypeScript infers.",
    },
  },
  create(context) {
    let file: TypeAwareLintFileService | undefined;
    /** `annotation` is Oxlint's TSTypeAnnotation: the `: Foo` after the declared name. */
    function check(annotation: any, start: number | undefined, init: Node) {
      const calls: Node[] = [];
      if (start === undefined || !collectContextFreeCalls(init, calls)) return;
      file ||= getTypeAwareLintFileService(context);
      const sourceFile = file?.project.program.getSourceFile(file.fileName);
      if (!file || !sourceFile) return;
      const declaration = ancestor(
        getTokenAtPosition(sourceFile, start),
        (node) => isVariableDeclaration(node) || isPropertyDeclaration(node),
      );
      if (!declaration?.type || !declaration.initializer) return;
      const checker = file.project.checker;
      for (const call of calls) {
        const tsCall = ancestor(
          getTokenAtPosition(sourceFile, call.range![0]),
          (node): node is CallOrNewExpression =>
            isCallOrNewExpression(node) && node.end === call.range![1],
        );
        // An instantiated signature has a target: the call inferred its type arguments, and the
        // annotation took part in that inference.
        if (!tsCall || checker.getResolvedSignature(tsCall)?.target !== undefined) return;
      }
      const declared = checker.getTypeFromTypeNode(declaration.type);
      // Every type the checker cannot resolve is one error type, flagged Any, so two of them match
      // whatever they were meant to name.
      if (!declared || declared.flags & TypeFlags.Any) return;
      if (declared.id !== checker.getTypeAtLocation(declaration.initializer)?.id) return;
      context.report({
        node: annotation,
        messageId: "inferable",
        data: { type: context.sourceCode.getText(annotation.typeAnnotation) },
        // The types are one type, so dropping the annotation changes nothing the checker sees.
        fix: (fixer) => fixer.remove(annotation),
      });
    }
    return {
      VariableDeclarator(node: any) {
        if (!node.id.typeAnnotation || !node.init) return;
        check(node.id.typeAnnotation, node.id.range?.[0], node.init);
      },
      PropertyDefinition(node: any) {
        if (!node.typeAnnotation || !node.value || node.declare) return;
        check(node.typeAnnotation, node.key.range?.[0], node.value);
      },
    };
  },
};

/** Whether `node`'s type ignores its contextual type, pushing the calls whose signatures decide it.
 *  `node` is Oxlint's AST, which adds TypeScript and JSX nodes to ESTree's. */
function collectContextFreeCalls(node: any, calls: Node[]): boolean {
  switch (node.type) {
    case "Identifier":
    case "ThisExpression":
    case "MemberExpression":
    case "TSAsExpression":
    case "TSTypeAssertion":
    case "TSSatisfiesExpression":
    case "JSXElement":
    case "JSXFragment":
      return true;
    case "Literal":
      return node.value === null && !node.regex;
    case "TSNonNullExpression":
    case "ChainExpression":
      return collectContextFreeCalls(node.expression, calls);
    case "AwaitExpression":
      return collectContextFreeCalls(node.argument, calls);
    case "ConditionalExpression":
      return (
        collectContextFreeCalls(node.consequent, calls) &&
        collectContextFreeCalls(node.alternate, calls)
      );
    case "LogicalExpression":
      return (
        collectContextFreeCalls(node.left, calls) && collectContextFreeCalls(node.right, calls)
      );
    case "CallExpression":
    case "NewExpression":
      // Explicit type arguments leave nothing to infer.
      if (!node.typeArguments) calls.push(node);
      return true;
    default:
      return false;
  }
}

function ancestor<T extends TsNode>(node: TsNode | undefined, test: (node: TsNode) => node is T) {
  for (let current = node; current; current = current.parent) if (test(current)) return current;
  return undefined;
}
