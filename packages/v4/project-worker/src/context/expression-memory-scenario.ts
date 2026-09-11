// expression-memory-scenario.ts — a capped child process for the expression codec's largest
// processor-hosting argument. The Worker isolate has the same 128 MiB heap budget.
import { z } from "zod";
import { parse, print } from "./expression.ts";

const sourceChars = 4.5 * 1024 * 1024;
const expression = `itx.facets.get({className:'Processor',source:'${"x".repeat(sourceChars)}'})`;
const parsed = parse(expression);
const [, , get] = parsed;

const [, { source }] = z
  .tuple([z.literal("get"), z.object({ source: z.string().length(sourceChars) })])
  .parse(get);
const printed = print(parsed);
const reparsed = parse(printed);
if (JSON.stringify(reparsed) !== JSON.stringify(parsed))
  throw new Error("fixture: the hosted facet expression did not round-trip");

console.log(JSON.stringify({ sourceChars: source.length, printedChars: printed.length }));
