// Executable spec for the expression codec — two directions over one table.
import { describe, expect, test } from "vitest";
import { parse, print, type ItxExpression } from "./expression.ts";

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
