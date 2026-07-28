import type { AnchorSelector, SourceRange } from "./types.ts";

// Anchor reconciliation. Anchor drift is nonfatal by design: a thread whose
// quoted text moved, changed, or vanished keeps its valid discussion and gets
// a resolution state instead of a parse error. Reconciliation order follows
// the task spec: inline marker → stored position → unique exact quote
// (context-disambiguated) → high-confidence fuzzy match → needs_review /
// orphaned.

export type AnchorState = "attached" | "needs_review" | "orphaned";

export interface AnchorResolution {
  state: AnchorState;
  method: "marker" | "position" | "quote" | "fuzzy" | null;
  /** Body-relative range of the anchored text (or of the inline marker). */
  range: SourceRange | null;
  /** 1 for exact methods; the similarity score for fuzzy outcomes. */
  confidence: number;
}

const MAX_OCCURRENCES = 64;
const MAX_FUZZY_BODY_LENGTH = 256 * 1024;
const FUZZY_ATTACH_THRESHOLD = 0.8;
const FUZZY_REVIEW_THRESHOLD = 0.6;
const FUZZY_AMBIGUITY_MARGIN = 0.05;

export function createAnchorSelector(
  body: string,
  start: number,
  end: number,
  context = 32,
): AnchorSelector {
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end <= start ||
    end > body.length
  ) {
    throw new Error(`invalid anchor selection ${start}..${end} for body of length ${body.length}`);
  }
  return {
    quote: {
      exact: body.slice(start, end),
      prefix: body.slice(Math.max(0, start - context), start),
      suffix: body.slice(end, Math.min(body.length, end + context)),
    },
    position: { start, end },
  };
}

export function findInlineMarker(body: string, threadId: string): SourceRange | null {
  const needle = `](#thread-${threadId})`;
  for (let idx = body.indexOf(needle); idx !== -1; idx = body.indexOf(needle, idx + 1)) {
    const open = body.lastIndexOf("[", idx);
    if (open !== -1 && !body.slice(open, idx).includes("\n")) {
      return { start: open, end: idx + needle.length };
    }
  }
  return null;
}

export function resolveThreadAnchor(
  body: string,
  threadId: string,
  selector: AnchorSelector | null,
): AnchorResolution {
  const marker = findInlineMarker(body, threadId);
  if (marker !== null) {
    if (selector !== null) {
      const exact = selector.quote.exact;
      // The writer inserts the marker directly after the quote, optionally
      // separated by one space — recover the quoted range when it survived.
      for (const gap of [0, 1]) {
        const start = marker.start - gap - exact.length;
        if (start >= 0 && body.startsWith(exact, start)) {
          return {
            state: "attached",
            method: "marker",
            range: { start, end: start + exact.length },
            confidence: 1,
          };
        }
      }
    }
    return { state: "attached", method: "marker", range: marker, confidence: 1 };
  }
  if (selector === null) {
    return { state: "orphaned", method: null, range: null, confidence: 0 };
  }

  const exact = selector.quote.exact;
  const position = selector.position;
  if (position !== undefined && body.startsWith(exact, position.start)) {
    return {
      state: "attached",
      method: "position",
      range: { start: position.start, end: position.start + exact.length },
      confidence: 1,
    };
  }

  const occurrences: number[] = [];
  for (let i = body.indexOf(exact); i !== -1; i = body.indexOf(exact, i + 1)) {
    occurrences.push(i);
    if (occurrences.length > MAX_OCCURRENCES) break;
  }
  if (occurrences.length === 1 && occurrences[0] !== undefined) {
    return {
      state: "attached",
      method: "quote",
      range: { start: occurrences[0], end: occurrences[0] + exact.length },
      confidence: 1,
    };
  }
  if (occurrences.length > 1) {
    let best = -1;
    let bestScore = -1;
    let tie = false;
    for (const occ of occurrences) {
      const score = contextScore(body, occ, exact.length, selector);
      if (score > bestScore) {
        best = occ;
        bestScore = score;
        tie = false;
      } else if (score === bestScore) {
        tie = true;
      }
    }
    if (!tie && best !== -1) {
      return {
        state: "attached",
        method: "quote",
        range: { start: best, end: best + exact.length },
        confidence: 1,
      };
    }
    return { state: "needs_review", method: "quote", range: null, confidence: 0.5 };
  }

  return fuzzyResolve(body, selector);
}

function contextScore(
  body: string,
  start: number,
  length: number,
  selector: AnchorSelector,
): number {
  const { prefix, suffix } = selector.quote;
  let score = 0;
  for (let i = 0; i < prefix.length; i++) {
    const bodyIndex = start - 1 - i;
    const prefixChar = prefix[prefix.length - 1 - i];
    if (bodyIndex < 0 || body[bodyIndex] !== prefixChar) break;
    score++;
  }
  const end = start + length;
  for (let i = 0; i < suffix.length; i++) {
    if (end + i >= body.length || body[end + i] !== suffix[i]) break;
    score++;
  }
  return score;
}

function fuzzyResolve(body: string, selector: AnchorSelector): AnchorResolution {
  const exact = selector.quote.exact;
  if (body.length > MAX_FUZZY_BODY_LENGTH || exact.length < 4) {
    return { state: "orphaned", method: null, range: null, confidence: 0 };
  }

  // First a whitespace-insensitive exact match: reflowed prose is the most
  // common drift and deserves full confidence over sliding-window scoring.
  const normalizedBody = normalizeWithMap(body);
  const normalizedExact = exact.replace(/\s+/g, " ").trim();
  if (normalizedExact.length >= 4) {
    const normOccurrences: number[] = [];
    for (
      let i = normalizedBody.text.indexOf(normalizedExact);
      i !== -1;
      i = normalizedBody.text.indexOf(normalizedExact, i + 1)
    ) {
      normOccurrences.push(i);
      if (normOccurrences.length > MAX_OCCURRENCES) break;
    }
    if (normOccurrences.length === 1 && normOccurrences[0] !== undefined) {
      const start = normalizedBody.map[normOccurrences[0]];
      const endMapIndex = normOccurrences[0] + normalizedExact.length - 1;
      const endChar = normalizedBody.map[endMapIndex];
      if (start !== undefined && endChar !== undefined) {
        return {
          state: "attached",
          method: "fuzzy",
          range: { start, end: endChar + 1 },
          confidence: 0.95,
        };
      }
    }
    if (normOccurrences.length > 1) {
      return { state: "needs_review", method: "fuzzy", range: null, confidence: 0.5 };
    }
  }

  // Sliding-window bigram similarity (Dice coefficient) as the last resort.
  const window = exact.length;
  const step = Math.max(1, Math.floor(window / 8));
  const target = bigramCounts(exact);
  let bestStart = -1;
  let bestScore = 0;
  let runnerUpScore = 0;
  for (let start = 0; start + window <= body.length; start += step) {
    const score = diceSimilarity(target, bigramCounts(body.slice(start, start + window)));
    if (bestStart !== -1 && Math.abs(start - bestStart) < window) {
      // Same region as the current best: keep the max, don't count it as an
      // independent runner-up.
      if (score > bestScore) bestScore = score;
      continue;
    }
    if (score > bestScore) {
      runnerUpScore = bestScore;
      bestScore = score;
      bestStart = start;
    } else if (score > runnerUpScore) {
      runnerUpScore = score;
    }
  }
  if (bestStart === -1 || bestScore < FUZZY_REVIEW_THRESHOLD) {
    return { state: "orphaned", method: null, range: null, confidence: 0 };
  }
  const range: SourceRange = { start: bestStart, end: Math.min(body.length, bestStart + window) };
  if (bestScore >= FUZZY_ATTACH_THRESHOLD && bestScore - runnerUpScore >= FUZZY_AMBIGUITY_MARGIN) {
    return { state: "attached", method: "fuzzy", range, confidence: bestScore };
  }
  return { state: "needs_review", method: "fuzzy", range, confidence: bestScore };
}

function normalizeWithMap(text: string): { text: string; map: number[] } {
  let out = "";
  const map: number[] = [];
  let pendingSpace = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === undefined) break;
    if (/\s/.test(char)) {
      pendingSpace = out.length > 0;
      continue;
    }
    if (pendingSpace) {
      out += " ";
      map.push(i - 1);
      pendingSpace = false;
    }
    out += char;
    map.push(i);
  }
  return { text: out, map };
}

function bigramCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (let i = 0; i + 1 < text.length; i++) {
    const bigram = text.slice(i, i + 2);
    counts.set(bigram, (counts.get(bigram) ?? 0) + 1);
  }
  return counts;
}

function diceSimilarity(a: Map<string, number>, b: Map<string, number>): number {
  let aTotal = 0;
  for (const count of a.values()) aTotal += count;
  let bTotal = 0;
  for (const count of b.values()) bTotal += count;
  if (aTotal === 0 || bTotal === 0) return 0;
  let overlap = 0;
  for (const [bigram, count] of a) {
    const other = b.get(bigram);
    if (other !== undefined) overlap += Math.min(count, other);
  }
  return (2 * overlap) / (aTotal + bTotal);
}
