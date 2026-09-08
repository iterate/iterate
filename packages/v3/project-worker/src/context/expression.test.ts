// Executable spec for the expression codec — two directions over one table.
import { describe, expect, test } from "vitest";
import {
  parse,
  parseItxExpressionPrefix,
  print,
  toItxExpression,
  type ItxExpression,
} from "./expression.ts";

// Plausible itx expressions in CANONICAL form — exactly what `print` emits (single-quoted strings,
// unquoted identifier keys, no spaces). Each row is checked BOTH directions.
const TABLE: [string, ItxExpression][] = [
  ["itx.kv", ["itx", "kv"]], // a getter path (no call)
  ["itx.whoami()", ["itx", ["whoami"]]], // a call with no args
  ["itx.kv.get('src/app.js')", ["itx", "kv", ["get", "src/app.js"]]],
  ["itx.kv.put('k','v')", ["itx", "kv", ["put", "k", "v"]]], // multiple args
  ["itx.facets.get('tally').snapshot()", ["itx", "facets", ["get", "tally"], ["snapshot"]]], // chain
  ["itx.robots.get('robot-arm-1').ping()", ["itx", "robots", ["get", "robot-arm-1"], ["ping"]]],
  [
    "itx.facets.get({className:'CounterDurableObject'})",
    ["itx", "facets", ["get", { className: "CounterDurableObject" }]],
  ],
  [
    // the CANONICAL spelling sorts object keys (one spelling per object ⇒ one rewrite-rule row)
    "itx.append({payload:{n:1,ok:true,tags:['a','b']},type:'evt'})",
    ["itx", ["append", { type: "evt", payload: { n: 1, ok: true, tags: ["a", "b"] } }]],
  ],
  ["itx.math.add(1,-2.5,true,null)", ["itx", "math", ["add", 1, -2.5, true, null]]], // primitives
];

describe("expression codec", () => {
  test.each(TABLE)("parse: %s", (str, expr) => {
    expect(parse(str)).toEqual(expr);
  });
  test.each(TABLE)("print: %s", (str, expr) => {
    expect(print(expr)).toBe(str);
  });
});

// parse → print collapses whitespace, quote style and OBJECT KEY ORDER to ONE spelling — a call and
// a rule's match alike. So two spellings of one pinned object are ONE rewrite-rule row (the table is
// a map by the printed match) and `rewriteRules.get` finds a row however the caller spells it.
const CANONICAL: { spelled: string; becomes: string }[] = [
  { spelled: "itx.ai.run({model:'x',fast:true})", becomes: "itx.ai.run({fast:true,model:'x'})" },
  { spelled: "itx.ai.run({fast:true,model:'x'})", becomes: "itx.ai.run({fast:true,model:'x'})" },
  { spelled: 'itx.ai.run( "x" , {b:1, a:2} )', becomes: "itx.ai.run('x',{a:2,b:1})" },
];
describe("canonical spelling: parse → print", () => {
  test.each(CANONICAL)("$spelled prints as $becomes", ({ spelled, becomes }) => {
    expect(print(parse(spelled))).toBe(becomes);
    expect(print(parseItxExpressionPrefix(spelled))).toBe(becomes); // a rule's match, the same way
  });
});

// A JSON5 comment inside call args is a comment — never a marker, never a quote: the one span the
// lexer and the paren walker skip is "a string literal OR a comment".
const COMMENTED: { spelled: string; parsesTo: ItxExpression }[] = [
  { spelled: "itx.x(/* @ */ 1)", parsesTo: ["itx", ["x", 1]] },
  { spelled: "itx.x(1 /* it's */, 2)", parsesTo: ["itx", ["x", 1, 2]] },
  { spelled: "itx.x(1, // a ')' here\n 2)", parsesTo: ["itx", ["x", 1, 2]] },
  {
    spelled: "itx.x('// not a comment', '/* nor this */')",
    parsesTo: ["itx", ["x", "// not a comment", "/* nor this */"]],
  },
];
describe("comments inside call args", () => {
  test.each(COMMENTED)("$spelled parses", ({ spelled, parsesTo }) => {
    expect(parse(spelled)).toEqual(parsesTo);
  });
});

test("a string expression over the char limit is refused, coded, before any parsing; the parsed form carries the same thing", () => {
  const big = `itx.workers.get({ source: { "cap.js": ${JSON.stringify("x".repeat(3000))} } })`;
  expect(() => parse(big)).toThrowError(/EXPRESSION_TOO_LONG|over the 2048-char limit/);
  expect(
    toItxExpression(["itx", "workers", ["get", { source: { "cap.js": "x".repeat(3000) } }]]),
  ).toHaveLength(3);
});
