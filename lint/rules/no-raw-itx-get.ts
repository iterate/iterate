// iterate/no-raw-itx-get: code reaches its context through `withItx`, never a raw `ITX.get()`, and a
// `withItx` callback answers data, never the live value it is about to release.
// Why, and what to write instead: ./no-raw-itx-get.md.
import type { Rule } from "eslint";
import type { StrictRule } from "../types.ts";
import { getPropertyName } from "./ast.ts";

/** The fields this rule reads off oxlint's ESTree nodes, TypeScript wrappers included, which
 *  @types/estree does not describe. */
type AstNode = { type: string; parent?: AstNode; [key: string]: any };

const MESSAGE =
  "Reach the context through withItx: `withItx(this.env.ITX, (itx) => …)` from ./processor.js, or `this.withItx(fn)` on an SDK host (ConfigWorker, StreamProcessorDurableObject); an object that needs reach takes a `WithItx` accessor. A raw ITX.get() hands out a scope nothing releases, and whatever is kept from it keeps its context, and any facet holding it, resident after the context is evicted (apps/os/docs/residency.md).";

const LIVE_ANSWER =
  "This withItx callback answers a live value (the scope, a property of it, or an `itx.cd(path)` handle), and withItx releases it before the caller gets it. Answer data (`(await itx.cd(path).whoami()).path`); an object that needs reach takes a `WithItx` accessor and makes its own round trips.";

/** A raw get in a module handed over as text. */
const RAW_GET_IN_TEXT = /\bITX\??\.get\(\s*\)/g;

export const noRawItxGetRule: StrictRule = {
  meta: {
    type: "problem",
    schema: [],
    docs: {
      description:
        "Code reaches its context through withItx, which releases the scope and every call made through it; a raw `env.ITX.get()`, in a file or an embedded `*.js` module, releases nothing, and a withItx callback that answers a live value hands its caller a released one.",
    },
  },
  create(context) {
    // A Set: a `/* js */` template that is also a `"*.js"` key's value is one module.
    const embeddedModules = new Set<AstNode>();
    const report = (node: AstNode | undefined, message: string) => {
      // The listeners' nodes are oxlint's own, which `context.report` takes back as they are.
      if (node) context.report({ node: node as unknown as Rule.Node, message });
    };
    return {
      // Each listener's node is read through `AstNode` (above): oxlint's ESTree, TS nodes included.
      CallExpression(node) {
        const call = node as unknown as AstNode;
        if (isRawItxGet(call)) report(call, MESSAGE);
        report(liveAnswerOfArrowCallback(call), LIVE_ANSWER);
      },
      ReturnStatement(node) {
        report(liveAnswerOfReturn(node as unknown as AstNode), LIVE_ANSWER);
      },
      // A module handed over as source text: a `"cap.js": …` entry of a module map (a string, a
      // template, `String.raw`, or a const holding one), or a template marked `/* js */`.
      Property(node) {
        if (!getPropertyName(node.key)?.endsWith(".js")) return;
        let value = unwrap(node.value as unknown as AstNode);
        if (value.type === "Identifier") value = constInit(context, value) ?? value;
        if (isModuleText(value)) embeddedModules.add(value);
      },
      TemplateLiteral(node) {
        if (isMarkedJs(context, node)) embeddedModules.add(node as unknown as AstNode);
      },
      TaggedTemplateExpression(node) {
        const tagged = node as unknown as AstNode;
        if (isStringRaw(tagged) && isMarkedJs(context, node)) embeddedModules.add(tagged);
      },
      "Program:exit"() {
        for (const literal of embeddedModules) {
          const text = moduleText(literal);
          const lines = [...text.matchAll(RAW_GET_IN_TEXT)].map(
            (match) => text.slice(0, match.index).split("\n").length,
          );
          if (lines.length > 0)
            report(
              literal,
              `This embedded module calls ITX.get() raw (its line ${[...new Set(lines)].join(", ")}). ${MESSAGE}`,
            );
        }
      },
    };
  },
};

/** A zero-argument `.get()` on `ITX` or on an `<x>.ITX` member: `this.env.ITX.get()`,
 *  `env?.ITX?.get()`, `env["ITX"].get()`, `(env as any).ITX.get()`, a destructured `ITX.get()`. An
 *  alias of the binding is not followed: no first-party code keeps one. */
function isRawItxGet(call: AstNode): boolean {
  const callee = unwrap(call.callee);
  if (call.arguments.length > 0 || callee.type !== "MemberExpression") return false;
  const object = unwrap(callee.object);
  return (
    memberName(callee) === "get" &&
    ((object.type === "Identifier" && object.name === "ITX") ||
      (object.type === "MemberExpression" && memberName(object) === "ITX"))
  );
}

/** `withItx(binding, (itx) => <live>)` / `this.withItx((itx) => <live>)`: the live answer, if any. */
function liveAnswerOfArrowCallback(call: AstNode): AstNode | undefined {
  const callback = withItxCallbackOf(call);
  if (callback?.type !== "ArrowFunctionExpression" || callback.body.type === "BlockStatement")
    return undefined;
  return isLiveAnswer(callback.body, callback.params[0]) ? callback.body : undefined;
}

/** `return <live>` directly inside a withItx callback's block body: the live answer, if any. */
function liveAnswerOfReturn(statement: AstNode): AstNode | undefined {
  if (!statement.argument) return undefined;
  let callback = statement.parent;
  while (callback && !isFunction(callback) && callback.type !== "FunctionDeclaration")
    callback = callback.parent;
  if (!callback?.parent || withItxCallbackOf(callback.parent) !== callback) return undefined;
  return isLiveAnswer(statement.argument, callback.params[0]) ? statement.argument : undefined;
}

/** The callback of a `withItx(…, callback)` or `<x>.withItx(callback)` call. */
function withItxCallbackOf(call: AstNode): AstNode | undefined {
  if (call.type !== "CallExpression") return undefined;
  const callee = unwrap(call.callee);
  const named =
    (callee.type === "Identifier" && callee.name === "withItx") ||
    (callee.type === "MemberExpression" && memberName(callee) === "withItx");
  const callback: AstNode | undefined = call.arguments.at(-1);
  return named && isFunction(callback) ? callback : undefined;
}

/** The scope parameter itself, a property path of it with no call (`itx.repos`), or an
 *  `itx.cd(path)` handle, awaited or not: live values withItx releases before its caller sees them.
 *  Anything else a call answers may be data, which lint cannot tell from a handle. */
function isLiveAnswer(answer: AstNode, parameter: AstNode | undefined): boolean {
  if (parameter?.type !== "Identifier") return false;
  let node = unwrap(answer);
  if (node.type === "AwaitExpression") node = unwrap(node.argument);
  if (node.type !== "CallExpression") return rootName(node, false) === parameter.name;
  const callee = unwrap(node.callee);
  return (
    callee.type === "MemberExpression" &&
    memberName(callee) === "cd" &&
    rootName(callee.object, true) === parameter.name
  );
}

/** The identifier a member chain starts from: `itx` of `itx.a.b`, and of `itx.a(…).b` when calls
 *  may be crossed. */
function rootName(node: AstNode, crossCalls: boolean): string | undefined {
  let current = unwrap(node);
  for (;;) {
    if (current.type === "MemberExpression") current = unwrap(current.object);
    else if (crossCalls && current.type === "CallExpression") current = unwrap(current.callee);
    else return current.type === "Identifier" ? current.name : undefined;
  }
}

function isFunction(node: AstNode | undefined): boolean {
  return node?.type === "ArrowFunctionExpression" || node?.type === "FunctionExpression";
}

/** A member's static name: `a.name`, `a["name"]`. */
function memberName(member: AstNode): string | undefined {
  if (member.computed && member.property.type !== "Literal") return undefined;
  return getPropertyName(member.property);
}

/** The expression under parentheses, optional chaining and TypeScript's type-only wrappers. */
function unwrap(node: AstNode): AstNode {
  let current = node;
  while (
    current.type === "ChainExpression" ||
    current.type === "ParenthesizedExpression" ||
    current.type === "TSNonNullExpression" ||
    current.type === "TSAsExpression" ||
    current.type === "TSSatisfiesExpression" ||
    current.type === "TSTypeAssertion"
  )
    current = current.expression;
  return current;
}

/** What the variable `identifier` names is initialized to, when it is declared once. */
function constInit(context: Rule.RuleContext, identifier: AstNode): AstNode | undefined {
  // The scope manager takes oxlint's node back as it is.
  for (
    let scope: any = context.sourceCode.getScope(identifier as never);
    scope;
    scope = scope.upper
  ) {
    const defs = scope.set.get(identifier.name)?.defs;
    if (!defs) continue;
    const declarator = defs.length === 1 ? defs[0].node : undefined;
    return declarator?.type === "VariableDeclarator" && declarator.init
      ? unwrap(declarator.init)
      : undefined;
  }
  return undefined;
}

function isStringRaw(node: AstNode): boolean {
  const tag = node.type === "TaggedTemplateExpression" ? unwrap(node.tag) : undefined;
  return (
    tag?.type === "MemberExpression" &&
    memberName(tag) === "raw" &&
    unwrap(tag.object).type === "Identifier" &&
    unwrap(tag.object).name === "String"
  );
}

function isModuleText(node: AstNode): boolean {
  return (
    (node.type === "Literal" && typeof node.value === "string") ||
    node.type === "TemplateLiteral" ||
    isStringRaw(node)
  );
}

/** A template, or a `String.raw` template, marked `/* js *\/`. */
function isMarkedJs(context: Rule.RuleContext, node: Rule.Node): boolean {
  const marker = context.sourceCode.getCommentsBefore(node).at(-1);
  return marker?.type === "Block" && marker.value.trim() === "js";
}

/** A module's text: a template's quasis (raw for `String.raw`, else cooked), joined by `_$`. */
function moduleText(literal: AstNode): string {
  if (literal.type === "Literal") return literal.value;
  if (literal.type === "TaggedTemplateExpression")
    return literal.quasi.quasis.map((quasi: AstNode) => quasi.value.raw).join("_$");
  return literal.quasis.map((quasi: AstNode) => quasi.value.cooked ?? "").join("_$");
}
