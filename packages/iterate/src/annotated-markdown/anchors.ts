import approxSearch from "approx-string-match";
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
const MIN_APPROX_QUOTE_LENGTH = 8;

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
  if (marker) {
    if (selector) {
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
  if (!selector) {
    return { state: "orphaned", method: null, range: null, confidence: 0 };
  }

  const exact = selector.quote.exact;
  const position = selector.position;
  if (position && body.startsWith(exact, position.start)) {
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
  if (occurrences.length === 1 && Number.isFinite(occurrences[0])) {
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
    if (normOccurrences.length === 1 && Number.isFinite(normOccurrences[0])) {
      const start = normalizedBody.map[normOccurrences[0]];
      const endMapIndex = normOccurrences[0] + normalizedExact.length - 1;
      const endChar = normalizedBody.map[endMapIndex];
      if (Number.isFinite(start) && Number.isFinite(endChar)) {
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

  // Approximate search (bitap over edit distance — the engine Hypothesis
  // settled on) as the last resort. Candidates are RANKED by a weighted
  // fusion of quote similarity, surviving context, and distance from the
  // recorded position; the reported confidence stays the quote similarity
  // alone so thresholds keep their meaning.
  if (exact.length < MIN_APPROX_QUOTE_LENGTH) {
    // One-or-two-word quotes produce spurious approximate matches; they only
    // attach via the exact rungs above.
    return { state: "orphaned", method: null, range: null, confidence: 0 };
  }
  const maxErrors = Math.floor(exact.length * (1 - FUZZY_REVIEW_THRESHOLD));
  const matches = approxSearch(body, exact, maxErrors);
  interface Candidate {
    range: SourceRange;
    similarity: number;
    rank: number;
  }
  let best: Candidate | null = null;
  let runnerUp: Candidate | null = null;
  for (const match of matches) {
    const similarity = 1 - match.errors / exact.length;
    const context =
      contextScore(body, match.start, match.end - match.start, selector) /
      Math.max(1, selector.quote.prefix.length + selector.quote.suffix.length);
    const positionCloseness = selector.position
      ? 1 - Math.min(1, Math.abs(match.start - selector.position.start) / Math.max(1, body.length))
      : 0;
    const rank = similarity + 0.25 * context + 0.1 * positionCloseness;
    const candidate: Candidate = {
      range: { start: match.start, end: match.end },
      similarity,
      rank,
    };
    if (best && Math.abs(candidate.range.start - best.range.start) < exact.length) {
      // Same region as the current best: keep the better, don't count it as
      // an independent runner-up.
      if (candidate.rank > best.rank) best = candidate;
      continue;
    }
    if (!best || candidate.rank > best.rank) {
      runnerUp = best;
      best = candidate;
    } else if (!runnerUp || candidate.rank > runnerUp.rank) {
      runnerUp = candidate;
    }
  }
  if (!best || best.similarity < FUZZY_REVIEW_THRESHOLD) {
    return { state: "orphaned", method: null, range: null, confidence: 0 };
  }
  if (
    best.similarity >= FUZZY_ATTACH_THRESHOLD &&
    (!runnerUp || best.rank - runnerUp.rank >= FUZZY_AMBIGUITY_MARGIN)
  ) {
    return { state: "attached", method: "fuzzy", range: best.range, confidence: best.similarity };
  }
  return { state: "needs_review", method: "fuzzy", range: best.range, confidence: best.similarity };
}

function normalizeWithMap(text: string): { text: string; map: number[] } {
  let out = "";
  const map: number[] = [];
  let pendingSpace = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (!char) break;
    if (/\s/.test(char)) {
      pendingSpace = !!out.length;
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
