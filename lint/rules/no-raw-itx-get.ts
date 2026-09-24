// iterate/no-raw-itx-get: code reaches its context through `withItx`, never a raw `ITX.get()`, and a
// `withItx` callback answers data, never the live value it is about to release.
// Why, and what to write instead: ./no-raw-itx-get.md.
import { parse } from "acorn";
import type { Rule } from "eslint";
import type { StrictRule } from "../types.ts";
import { getPropertyName } from "./ast.ts";

/** The shape of every AST node the matcher walks: oxlint's ESTree (TypeScript nodes included) in a
 *  linted file, acorn's in an embedded module. */
type AstNode = { type: string; parent?: AstNode; [key: string]: any };

/** Where the ITX binding can have been put, found through the file's scope manager in a linted file
 *  and by name in an embedded module (which has none). `depth` bounds an alias cycle. */
type Bindings = {
  /** The identifiers that bind the variable `identifier` reads: declarations, parameters and the
   *  targets of assignments to it. */
  sitesOf(identifier: AstNode): AstNode[];
  /** The values assigned to `this.<member>` in its class: a field's initializer, `this.m = …`. */
  valuesOfMember(member: AstNode): AstNode[];
};

const MESSAGE =
  "Reach the context through withItx: `withItx(this.env.ITX, (itx) => …)` from ./processor.js, or `this.withItx(fn)` on an SDK host (ConfigWorker, StreamProcessorDurableObject); an object that needs reach takes a `WithItx` accessor. A raw ITX.get() hands out a scope nothing releases, and whatever is kept from it keeps its context, and any facet holding it, resident after the context is evicted (apps/os/docs/residency.md).";

const LIVE_ANSWER =
  "This withItx callback answers a live value (the scope, a property of it, or an `itx.cd(path)` handle), and withItx releases it before the caller gets it. Answer data (`(await itx.cd(path).whoami()).path`); an object that needs reach takes a `WithItx` accessor and makes its own round trips.";

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
    const embeddedModules = new Set<AstNode>();
    const calls: AstNode[] = [];
    const returns: AstNode[] = [];
    const members = new MemberValues();
    const variableOf = (identifier: AstNode): any => {
      let scope: any = context.sourceCode.getScope(identifier as never);
      while (scope) {
        const variable = scope.set.get(identifier.name);
        if (variable) return variable;
        scope = scope.upper;
      }
      return undefined;
    };
    const bindings: Bindings = {
      sitesOf(identifier) {
        const variable = variableOf(identifier);
        if (!variable) return [];
        return [
          ...variable.defs.map((def: any) => def.name),
          ...variable.references
            .filter((reference: any) => reference.isWrite())
            .map((reference: any) => reference.identifier),
        ];
      },
      valuesOfMember: (member) => members.valuesOf(member),
    };
    return {
      CallExpression(node) {
        calls.push(node as unknown as AstNode);
      },
      ReturnStatement(node) {
        returns.push(node as unknown as AstNode);
      },
      PropertyDefinition(node) {
        members.addField(node as unknown as AstNode);
      },
      AssignmentExpression(node) {
        members.addAssignment(node as unknown as AstNode);
      },
      // A module handed over as source text: a `"cap.js": …` entry of a module map (a string, a
      // template, `String.raw`, or a const holding one), or a template marked `/* js */`.
      Property(node) {
        const key = getPropertyName(node.key);
        if (!key?.endsWith(".js")) return;
        const value = unwrap(node.value as unknown as AstNode);
        if (isModuleText(value)) embeddedModules.add(value);
        else if (value.type === "Identifier") {
          const defs = variableOf(value)?.defs ?? [];
          const init = defs.length === 1 ? defs[0].node?.init : undefined;
          if (defs[0]?.node?.type === "VariableDeclarator" && init && isModuleText(unwrap(init)))
            embeddedModules.add(unwrap(init));
        }
      },
      TemplateLiteral(node) {
        if (isMarkedJs(context, node)) embeddedModules.add(node as unknown as AstNode);
      },
      TaggedTemplateExpression(node) {
        if (isStringRaw(node as unknown as AstNode) && isMarkedJs(context, node))
          embeddedModules.add(node as unknown as AstNode);
      },
      "Program:exit"() {
        for (const call of calls) {
          if (isRawItxGet(call, bindings))
            context.report({ node: call as never, message: MESSAGE });
          const live = liveAnswerOfArrowCallback(call);
          if (live) context.report({ node: live as never, message: LIVE_ANSWER });
        }
        for (const statement of returns) {
          const live = liveAnswerOfReturn(statement);
          if (live) context.report({ node: live as never, message: LIVE_ANSWER });
        }
        for (const literal of embeddedModules) {
          const checked = checkModule(moduleText(literal));
          if (checked.unparsed)
            context.report({
              node: literal as unknown as Rule.Node,
              message: `This embedded module mentions ITX but does not parse as JavaScript (${checked.unparsed}), so iterate/no-raw-itx-get cannot check it. Hand over plain JavaScript; a module whose subject is the careless keep disables the rule with the reason.`,
            });
          if (checked.rawGetLines.length > 0)
            context.report({
              node: literal as unknown as Rule.Node,
              message: `This embedded module calls ITX.get() raw (its line ${checked.rawGetLines.join(", ")}). ${MESSAGE}`,
            });
          if (checked.liveAnswerLines.length > 0)
            context.report({
              node: literal as unknown as Rule.Node,
              message: `This embedded module's withItx callback answers a live value (its line ${checked.liveAnswerLines.join(", ")}). ${LIVE_ANSWER}`,
            });
        }
      },
    };
  },
};

/** What each class assigns to its own members: `m = …` / `#m = …` fields and `this.m = …`. */
class MemberValues {
  #values = new Map<AstNode, Map<string, AstNode[]>>();
  addField(field: AstNode) {
    const key = memberKey(field.key, field.computed);
    if (key && field.value && field.parent) this.#add(field.parent, key, field.value);
  }
  addAssignment(assignment: AstNode) {
    const target = unwrap(assignment.left);
    const key = isThisMember(target) ? memberKey(target.property, target.computed) : undefined;
    const body = enclosingClassBody(assignment);
    if (key && body) this.#add(body, key, assignment.right);
  }
  valuesOf(member: AstNode): AstNode[] {
    const key = memberKey(member.property, member.computed);
    const body = enclosingClassBody(member);
    return (key && body && this.#values.get(body)?.get(key)) || [];
  }
  #add(body: AstNode, key: string, value: AstNode) {
    const values = this.#values.get(body) ?? new Map<string, AstNode[]>();
    this.#values.set(body, values);
    values.set(key, [...(values.get(key) ?? []), value]);
  }
}

/** `<x>.ITX.get()`, `.get()` on a destructured `{ ITX }`, an alias of `<x>.ITX` (declared, assigned,
 *  chained through another alias, or a class member), optional chaining and TypeScript wrappers
 *  included. Any raw call counts, a `try/finally` that disposes the scope too: that releases the
 *  scope, never the calls made through it. */
function isRawItxGet(node: AstNode, bindings: Bindings): boolean {
  if (node.type !== "CallExpression" || node.arguments.length > 0) return false;
  const callee = unwrap(node.callee);
  if (callee.type !== "MemberExpression" || memberName(callee) !== "get") return false;
  return holdsItx(callee.object, bindings, 0);
}

/** Whether `expression` is the ITX binding: `<x>.ITX`, or a name or `this` member bound from it. */
function holdsItx(expression: AstNode, bindings: Bindings, depth: number): boolean {
  if (depth > 8) return false; // an alias cycle, or a chain no one writes
  const node = unwrap(expression);
  if (node.type === "MemberExpression" && memberName(node) === "ITX") return true;
  if (node.type === "Identifier")
    return bindings.sitesOf(node).some((site) => isBoundFromItx(site, bindings, depth + 1));
  if (isThisMember(node))
    return bindings.valuesOfMember(node).some((value) => holdsItx(value, bindings, depth + 1));
  return false;
}

/** Whether the binding site `name` (an Identifier in a declaration, a parameter or an assignment
 *  target) takes the ITX binding: `{ ITX }`, `{ ITX: alias }` (a default included),
 *  `const alias = <ITX>`, `alias = <ITX>`. */
function isBoundFromItx(name: AstNode, bindings: Bindings, depth: number): boolean {
  let child = name;
  let parent = name.parent;
  if (parent?.type === "AssignmentPattern" && parent.left === child) {
    child = parent;
    parent = parent.parent;
  }
  if (parent?.type === "Property" && parent.value === child)
    return parent.parent?.type === "ObjectPattern" && getPropertyName(parent.key) === "ITX";
  if (parent?.type === "VariableDeclarator" && parent.id === child && parent.init)
    return holdsItx(parent.init, bindings, depth);
  if (
    parent?.type === "AssignmentExpression" &&
    parent.left === child &&
    ["=", "||=", "??=", "&&="].includes(parent.operator)
  )
    return holdsItx(parent.right, bindings, depth);
  return false;
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
  const callback = enclosingFunction(statement);
  const call = callback?.parent;
  if (!call || withItxCallbackOf(call) !== callback) return undefined;
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
  if (node.type === "CallExpression") {
    const callee = unwrap(node.callee);
    return (
      callee.type === "MemberExpression" &&
      memberName(callee) === "cd" &&
      rootName(callee.object, true) === parameter.name
    );
  }
  return rootName(node, false) === parameter.name;
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

function enclosingFunction(node: AstNode): AstNode | undefined {
  let current = node.parent;
  while (current && !isFunction(current) && current.type !== "FunctionDeclaration")
    current = current.parent;
  return isFunction(current) ? current : undefined;
}

function enclosingClassBody(node: AstNode): AstNode | undefined {
  let current = node.parent;
  while (current && current.type !== "ClassBody") current = current.parent;
  return current;
}

function isThisMember(node: AstNode): boolean {
  return node.type === "MemberExpression" && unwrap(node.object).type === "ThisExpression";
}

/** A member's static key: `m`, `#m` for a private one, a string literal's value. */
function memberKey(key: AstNode, computed: boolean): string | undefined {
  if (key.type === "PrivateIdentifier") return `#${key.name}`;
  if (computed) return key.type === "Literal" ? getPropertyName(key as never) : undefined;
  return getPropertyName(key as never);
}

function memberName(member: AstNode): string | undefined {
  return memberKey(member.property, member.computed);
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
function isMarkedJs(context: Rule.RuleContext, node: unknown): boolean {
  const marker = context.sourceCode.getCommentsBefore(node as never).at(-1);
  return marker?.type === "Block" && marker.value.trim() === "js";
}

/** A module's text: a template's quasis (raw for `String.raw`, cooked otherwise) with each `${…}`
 *  as the identifier `_$`, so the module still parses. */
function moduleText(literal: AstNode): string {
  if (literal.type === "Literal") return literal.value;
  if (literal.type === "TaggedTemplateExpression")
    return literal.quasi.quasis.map((quasi: AstNode) => quasi.value.raw).join("_$");
  return literal.quasis.map((quasi: AstNode) => quasi.value.cooked ?? "").join("_$");
}

/** An embedded module's raw ITX.get() lines and live withItx answers; `unparsed` (the parser's
 *  message) for text that mentions ITX but is not a module. Text that never mentions ITX is not
 *  this rule's to judge. */
function checkModule(text: string): {
  rawGetLines: number[];
  liveAnswerLines: number[];
  unparsed?: string;
} {
  if (!/\bITX\b|withItx/.test(text)) return { rawGetLines: [], liveAnswerLines: [] };
  let program: AstNode;
  try {
    program = parse(text, {
      ecmaVersion: "latest",
      sourceType: "module",
      locations: true,
    }) as never;
  } catch (error) {
    return {
      rawGetLines: [],
      liveAnswerLines: [],
      unparsed: error instanceof Error ? error.message : String(error),
    };
  }
  const nodes: AstNode[] = [];
  const visit = (node: AstNode, parent: AstNode | undefined) => {
    node.parent = parent;
    nodes.push(node);
    for (const [key, value] of Object.entries(node)) {
      if (key === "parent" || key === "loc") continue;
      for (const child of Array.isArray(value) ? value : [value])
        if (child && typeof child.type === "string") visit(child, node);
    }
  };
  visit(program, undefined);
  const members = new MemberValues();
  for (const node of nodes)
    if (node.type === "PropertyDefinition") members.addField(node);
    else if (node.type === "AssignmentExpression") members.addAssignment(node);
  // No scope manager: every identifier of the name is a candidate site; only a binding one binds.
  const bindings: Bindings = {
    sitesOf: (identifier) =>
      nodes.filter((node) => node.type === "Identifier" && node.name === identifier.name),
    valuesOfMember: (member) => members.valuesOf(member),
  };
  const lines = (found: AstNode[]) => [...new Set(found.map((node) => node.loc.start.line))];
  return {
    rawGetLines: lines(nodes.filter((node) => isRawItxGet(node, bindings))),
    liveAnswerLines: lines(
      nodes.flatMap((node) => {
        const live =
          node.type === "ReturnStatement"
            ? liveAnswerOfReturn(node)
            : liveAnswerOfArrowCallback(node);
        return live ? [live] : [];
      }),
    ),
  };
}
