// docs/anchor.ts — WHERE A COMMENT POINTS: a quote of the text it's about, never a position. A
// position goes stale with every edit before it; a quote is found again in whatever the text is now
// (a reload, an agent's rewrite, a commit made in git), the way a reader would find it. The page
// finds each thread's quote to highlight it; the doc's processor finds them again after each save and
// refreshes a quote that only matched loosely (processor.ts, `docs/comment-reanchored`), so the
// stored quote never drifts far from the text.
//
// FINDING a quote, in order:
//   1. the exact text: where it's once, there; where it's several times, the one whose surroundings
//      match the quote's prefix and suffix best;
//   2. its surroundings: the quote's prefix and then its suffix, close together, bracket what's there
//      now (the typo "teh" fixed to "the" between the same words) — a loose match;
//   3. neither: the quote is detached (null). The text it was about is gone or reworded around it.

/** What a comment points at: the text, and up to `CONTEXT` characters either side of it. */
export type Quote = { exact: string; prefix: string; suffix: string };

/** Where a quote is in a text now; `exact` false for a match by its surroundings alone. */
export type Found = { from: number; to: number; exact: boolean };

/** How much of each side a quote keeps: enough to tell repeats apart and to bracket an edit. */
const context = 32;

/** The quote of `text` between `from` and `to`. */
export function quoteAt(text: string, from: number, to: number): Quote {
  return {
    exact: text.slice(from, to),
    prefix: text.slice(Math.max(0, from - context), from),
    suffix: text.slice(to, to + context),
  };
}

/** Where `quote` is in `text` now, or null (detached). */
export function findQuote(text: string, quote: Quote): Found | null {
  const exact = occurrences(text, quote.exact);
  if (exact.length > 0) {
    const best = exact.reduce((a, b) => (fit(text, quote, b) > fit(text, quote, a) ? b : a));
    return { from: best, to: best + quote.exact.length, exact: true };
  }
  return bracketed(text, quote);
}

/** How well the text around `at` matches the quote's surroundings: characters in common, reading
 *  outward from the quote on each side. */
function fit(text: string, quote: Quote, at: number) {
  let score = 0;
  for (let i = 1; i <= quote.prefix.length && text[at - i] === quote.prefix.at(-i); i++) score++;
  const after = at + quote.exact.length;
  for (let i = 0; i < quote.suffix.length && text[after + i] === quote.suffix[i]; i++) score++;
  return score;
}

/** The text between the quote's prefix and suffix, where both are still there, in order and close
 *  (no further apart than the quote was long, plus room for the edit), and something is between. */
function bracketed(text: string, quote: Quote): Found | null {
  // at the start or end of the text, a side has nothing to find: its edge stands in
  const prefixes = quote.prefix
    ? occurrences(text, quote.prefix).map((at) => at + quote.prefix.length)
    : [0];
  const room = quote.exact.length * 2 + 16;
  let best: Found | null = null;
  for (const from of prefixes) {
    const to = quote.suffix ? text.indexOf(quote.suffix, from) : text.length;
    if (to < 0 || to - from > room || to === from) continue;
    // the nearest bracket wins: the least text between prefix and suffix
    if (!best || to - from < best.to - best.from) best = { from, to, exact: false };
  }
  return best;
}

function occurrences(text: string, part: string) {
  const found: number[] = [];
  for (let at = text.indexOf(part); at >= 0; at = text.indexOf(part, at + 1)) found.push(at);
  return found;
}
