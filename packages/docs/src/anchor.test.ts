import { expect, test } from "vitest";
import { findQuote, quoteAt, type Quote } from "./anchor.ts";

const doc = "# Offsite\n\nWe fly in on Tuesday and leave on Friday. The hotel is booked.\n";

test("a quote is found where its text is", () => {
  const quote = quoteOf(doc, "leave on Friday");
  const edited = `A new first line.\n${doc}`;
  expect(slice(edited, findQuote(edited, quote))).toEqual({ text: "leave on Friday", exact: true });
});

test("of several copies of the text, the one in the quote's surroundings is found", () => {
  const text = "Friday: drinks. We leave on Friday. Friday is a holiday.";
  const quote = quoteAt(text, text.indexOf("Friday."), text.indexOf("Friday.") + "Friday".length);
  expect(findQuote(text, quote)).toMatchObject({ from: text.indexOf("Friday."), exact: true });
});

test("a typo fixed under a comment keeps the comment, on the corrected word, as a loose match", () => {
  const typo = doc.replace("hotel", "hotle");
  const quote = quoteOf(typo, "hotle");
  expect(slice(doc, findQuote(doc, quote))).toEqual({ text: "hotel", exact: false });
});

test("a quote moves with its text", () => {
  const moved = "The hotel is booked. We fly in on Tuesday and leave on Friday.\n";
  const quote = quoteOf(doc, "leave on Friday");
  expect(slice(moved, findQuote(moved, quote))).toEqual({ text: "leave on Friday", exact: true });
});

test("a quote whose text is gone, and its surroundings reworded, is detached", () => {
  const quote = quoteOf(doc, "The hotel is booked.");
  const rewritten = "# Offsite\n\nPlans are still open.\n";
  expect(findQuote(rewritten, quote)).toBeNull();
});

test("a quote whose text was deleted between surroundings that stayed is detached, not empty", () => {
  const quote = quoteOf(doc, " The hotel is booked.");
  expect(findQuote(doc.replace(" The hotel is booked.", ""), quote)).toBeNull();
});

test("a quote at the very start or end of the text is found by one side alone", () => {
  const start = quoteAt(doc, 0, "# Offsite".length);
  const fixed = doc.replace("# Offsite", "# Off-site");
  expect(slice(fixed, findQuote(fixed, start))).toEqual({ text: "# Off-site", exact: false });
});

function quoteOf(text: string, part: string): Quote {
  const at = text.indexOf(part);
  return quoteAt(text, at, at + part.length);
}

function slice(text: string, found: ReturnType<typeof findQuote>) {
  return found && { text: text.slice(found.from, found.to), exact: found.exact };
}
