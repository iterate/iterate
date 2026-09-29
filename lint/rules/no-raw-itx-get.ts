// iterate/no-raw-itx-get: code reaches its context with `using itx = this.getItx()`, never a raw
// `ITX.get()`, and a `getItx()` scope is bound with `using` or handed out whole by an accessor.
// Why, and what to write instead: ./no-raw-itx-get.md.
import type { Rule } from "eslint";
import type { StrictRule } from "../types.ts";
import { getPropertyName } from "./ast.ts";

/** The fields this rule reads off oxlint's ESTree nodes, TypeScript wrappers included, which
 *  @types/estree does not describe. */
type AstNode = { type: string; parent?: AstNode; [key: string]: any };

const MESSAGE =
  "Reach the context with `using itx = this.getItx()`, which every loaded WorkerEntrypoint and SDK host (IterateConfigEntrypoint, FacetDurableObject, StreamProcessorDurableObject) has; an object that needs reach takes an accessor, `() => this.getItx()`. A raw ITX.get() hands out a scope nothing releases, and whatever is kept from it keeps its context, and any facet holding it, resident after the context is evicted (apps/os/docs/residency.md).";

/** A raw get in a module handed over as text. */
const RAW_GET_IN_TEXT = /\bITX\??\.get\(\s*\)/g;

export const noRawItxGetRule: StrictRule = {
  meta: {
    type: "problem",
    schema: [],
    docs: {
      description:
        "Code reaches its context with `using itx = this.getItx()`, which releases the scope and every call made through it when the block ends; a raw `env.ITX.get()`, in a file or an embedded `*.js` module, releases nothing, and neither does a getItx() no `using` binds.",
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
        if (isUnboundGetItx(call))
          report(
            call,
            "Bind this getItx() scope with `using` (`using itx = this.getItx()`) in the smallest block that holds its calls, or hand it out whole from an accessor (`() => this.getItx()`): nothing else releases it, and a scope nothing releases keeps its context, and any facet holding it, resident (apps/os/docs/residency.md).",
          );
      },
      // A module handed over as source text: a `"worker.js": …` (or `.ts`) entry of a source's files
      // (a string, a template, `String.raw`, or a const holding one), or a template marked `/* js */`.
      Property(node) {
        if (!/\.(js|ts)$/.test(getPropertyName(node.key) ?? "")) return;
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

/** A `getItx()` or `<x>.getItx()` call whose scope no `using` declaration binds and no accessor
 *  (`() => this.getItx()`, an arrow answering it whole) hands out: `const itx = this.getItx()`, a
 *  call chained on it, an argument. */
function isUnboundGetItx(call: AstNode): boolean {
  const callee = unwrap(call.callee);
  const named =
    (callee.type === "Identifier" && callee.name === "getItx") ||
    (callee.type === "MemberExpression" && memberName(callee) === "getItx");
  if (!named) return false;
  // out through parentheses and type-only wrappers (`unwrap`'s): `using itx = this.getItx() as Itx`
  let scope = call;
  while (scope.parent && unwrap(scope.parent) !== scope.parent) scope = scope.parent;
  const { parent } = scope;
  const bound =
    parent?.type === "VariableDeclarator" &&
    parent.init === scope &&
    ["using", "await using"].includes(parent.parent?.kind);
  const handedOut = parent?.type === "ArrowFunctionExpression" && parent.body === scope;
  return !bound && !handedOut;
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
