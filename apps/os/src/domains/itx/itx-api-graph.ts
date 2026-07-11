// The Itx Type Graph: the public itx surface kept per-declaration instead of
// as one flat file, so consumers can assemble bounded slices — a docs.get
// response, a __describe types field — rather than shipping all ~115KB
// everywhere. The flat projection (src/itx-api.generated.ts) and this graph
// are emitted by the same generator run from the same walk
// (scripts/generate-itx-api.ts); the graph's records are the flat file's
// declarations, verbatim.
//
// Identifier vocabulary is deliberately borrowed, not invented: "declaration"
// is the TypeScript grammar term, "summary" is the TSDoc term for the prose
// before the first block tag, "referenced type names" are the identifiers a
// declaration's signatures mention.
//
// The docs-door helpers that query the graph (search scoring, first-sentence
// extraction) live here too: they are pure, unit-tested functions shared by
// the docs RpcTarget and the generator.

/**
 * One exported declaration of the public itx surface, as the itx api
 * generator emits it. `sourceText` is the exact text of that declaration in
 * itx-api.generated.ts (leading JSDoc included); the other fields are derived
 * from it so runtime consumers (docs search, closure assembly) never re-parse
 * TypeScript.
 */
export interface ItxApiDeclaration {
  /** Exported declaration name, e.g. "Stream". Unique across the surface;
   * the key for docs lookups and docs-site deep links. */
  name: string;
  /** Which TypeScript declaration form this is. */
  kind: "interface" | "typeAlias";
  /** Verbatim TypeScript source including the leading JSDoc comment — the
   * exact text that appears in itx-api.generated.ts. */
  sourceText: string;
  /** The declaration's JSDoc summary (the prose before the first block tag),
   * first sentence. What search results and children maps show. */
  summary: string;
  /** JSDoc summary per interface member, keyed by member name. Empty for
   * type aliases. */
  memberSummaries: Record<string, string>;
  /** Names of other declarations in this graph that this declaration's
   * signatures mention — the edges a closure walk follows. Computed from
   * code only (JSDoc prose is not scanned). */
  referencedTypeNames: string[];
}

/** A search hit from `itx.docs.search`, in relevance order. */
export interface DocsSearchHit {
  /** What kind of corpus entry matched: an example script from the platform
   * catalogue, a type declaration, or a capability mounted in the caller's
   * scope. */
  kind: "example" | "type" | "capability";
  /** The name to fetch it by (example id, declaration name, or mount path). */
  name: string;
  /** One-line summary of the entry. */
  summary: string;
  /** The literal itx call that fetches the full entry — copy it verbatim. */
  fetchCall: string;
}

/**
 * Budgets are expressed in tokens because that is the unit the consumer (an
 * LLM context window) actually pays in; source text is roughly 4 characters
 * per token.
 */
const CHARS_PER_TOKEN = 4;
/** Provisional walk-budget reserve for the frontier trailer (assembly then
 * enforces the budget exactly) and the cap on the trailer's name listing. */
const TRAILER_RESERVE_CHARS = 600;
const TRAILER_NAME_LIST_CHARS = 400;

/** Index the graph by declaration name (names are unique — enforced by the
 * generator and the graph freshness test). */
export function declarationsByName(
  declarations: readonly ItxApiDeclaration[],
): Map<string, ItxApiDeclaration> {
  return new Map(declarations.map((declaration) => [declaration.name, declaration]));
}

/**
 * A bounded slice of the type graph: the requested declarations plus as much
 * of their reference closure as fits the budget, with an explicit frontier
 * naming what was left out (and how to fetch it). `itx.docs.get` returns the
 * `sourceText`; the structured fields exist for tests and future consumers.
 */
interface TypeSlice {
  /** TypeScript source: included declarations joined in walk order, ending
   * with a frontier comment when anything was left out. */
  sourceText: string;
  /** Declaration names included in full. */
  includedNames: string[];
  /** Referenced declaration names NOT included (budget or depth) — fetch
   * them with `itx.docs.get({ name })`. */
  frontierNames: string[];
}

/**
 * Assemble the bounded reference closure of one declaration: breadth-first
 * over `referencedTypeNames` from the root, adding whole declarations in walk
 * order until the next one would exceed the budget, then stopping. The root
 * is always included, truncated with a notice if it alone exceeds the budget
 * — a response that silently dropped the thing you asked for would read as
 * "it does not exist".
 */
export function typeSlice(input: {
  declarations: ReadonlyMap<string, ItxApiDeclaration>;
  rootName: string;
  maxTokens: number;
}): TypeSlice {
  const root = input.declarations.get(input.rootName);
  if (!root) {
    throw new Error(`unknown type declaration "${input.rootName}"`);
  }
  const budgetChars = input.maxTokens * CHARS_PER_TOKEN;
  // The walk stops early enough to leave room for the frontier trailer; the
  // assembly below then enforces the budget EXACTLY (drop or recut), so this
  // reserve only has to be a decent guess, never precise.
  const walkBudget = Math.max(0, budgetChars - TRAILER_RESERVE_CHARS);

  const includedNames: string[] = [];
  const parts: string[] = [];
  let usedChars = 0;
  let budgetExhausted = false;

  // Breadth-first queue seeded with the root; visit order is deterministic
  // (each declaration's referencedTypeNames are in source order).
  const queued = new Set<string>([root.name]);
  const queue: ItxApiDeclaration[] = [root];
  const frontier = new Set<string>();

  const enqueueReferences = (declaration: ItxApiDeclaration) => {
    for (const referencedName of declaration.referencedTypeNames) {
      if (queued.has(referencedName)) continue;
      queued.add(referencedName);
      const referenced = input.declarations.get(referencedName);
      if (referenced) queue.push(referenced);
    }
  };

  // The root is always included, truncated if it alone exceeds the budget —
  // a response that silently dropped the thing you asked for would read as
  // "it does not exist". `rootTruncated` defers the actual cut to assembly,
  // where the trailer's exact size is known.
  let rootTruncated = false;

  while (queue.length > 0) {
    const declaration = queue.shift()!;
    const cost = declaration.sourceText.length + 2; // +2 = the "\n\n" join separator
    if (!budgetExhausted && usedChars + cost <= walkBudget) {
      parts.push(declaration.sourceText);
      includedNames.push(declaration.name);
      usedChars += cost;
      enqueueReferences(declaration);
    } else if (includedNames.length === 0) {
      rootTruncated = true;
      includedNames.push(declaration.name);
      budgetExhausted = true;
      enqueueReferences(declaration);
    } else {
      // Once one declaration does not fit, stop adding (no best-fit packing:
      // deterministic and easy to reason about) — everything still queued
      // becomes frontier. Frontier declarations' own references stay
      // unexplored: they are beyond the frontier, reachable through a
      // follow-up docs.get on the frontier name.
      budgetExhausted = true;
      frontier.add(declaration.name);
    }
  }

  const trailerFor = (names: string[]): string => {
    if (names.length === 0) return "";
    const listed: string[] = [];
    let listedChars = 0;
    for (const name of names) {
      if (listedChars + name.length + 2 > TRAILER_NAME_LIST_CHARS) break;
      listed.push(name);
      listedChars += name.length + 2;
    }
    const unlisted = names.length - listed.length;
    return (
      `// Not included: ${listed.join(", ")}${unlisted > 0 ? ` … and ${unlisted} more` : ""}` +
      `\n// Fetch any referenced type with: await itx.docs.get({ name: "${listed[0] ?? names[0]}" })`
    );
  };

  const assemble = (): { sourceText: string; frontierNames: string[] } => {
    const frontierNames = [...frontier].sort();
    const trailer = trailerFor(frontierNames);
    const sourceText = [...parts, ...(trailer === "" ? [] : [trailer])].join("\n\n");
    return { sourceText, frontierNames };
  };

  // Exact budget enforcement: drop whole declarations from the end (they
  // rejoin the frontier) until the assembled text fits.
  let assembled = assemble();
  while (!rootTruncated && assembled.sourceText.length > budgetChars && parts.length > 1) {
    parts.pop();
    frontier.add(includedNames.pop()!);
    assembled = assemble();
  }

  if (rootTruncated) {
    // Cut the root to exactly what remains after the notice and trailer.
    const notice =
      `\n// … truncated: "${root.name}" alone exceeds maxTokens ${input.maxTokens} — ` +
      `retry with a larger maxTokens.`;
    const trailer = trailerFor([...frontier].sort());
    const cutLength = Math.max(
      0,
      budgetChars - notice.length - (trailer === "" ? 0 : trailer.length + 2) - 3,
    );
    const cut = root.sourceText.slice(0, cutLength);
    // Close a block comment the cut may have opened, so the notice and
    // trailer stay visible to a consumer rendering this as code.
    const openComment = cut.lastIndexOf("/*") > cut.lastIndexOf("*/");
    parts.unshift(cut + (openComment ? " */" : "") + notice);
    assembled = assemble();
  }

  return { ...assembled, includedNames };
}

/**
 * The platform declarations a free-form TypeScript text mentions: PascalCase
 * identifiers in its CODE (comments stripped) that name a declaration in the
 * graph. The same scan the generator uses for `referencedTypeNames`, applied
 * to text from OUTSIDE the graph — a mount's Capability Type Declaration —
 * so mount types get reference edges into the platform layer.
 */
export function referencedPlatformTypeNames(
  text: string,
  declarations: ReadonlyMap<string, ItxApiDeclaration>,
): string[] {
  const codeOnly = stripComments(text);
  // Names the text binds itself — its own declarations and import bindings —
  // shadow the platform ones and are not references.
  const locallyBound = new Set<string>();
  for (const declared of codeOnly.matchAll(
    /\b(?:type|interface|class|enum|namespace)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g,
  )) {
    locallyBound.add(declared[1]!);
  }
  for (const importClause of codeOnly.matchAll(/\bimport\s+(?:type\s+)?([^"']*?)\s*from\s*["']/g)) {
    for (const bound of importClause[1]!.matchAll(/\b[A-Za-z_$][A-Za-z0-9_$]*\b/g)) {
      locallyBound.add(bound[0]);
    }
  }
  const referenced = new Set<string>();
  for (const match of codeOnly.matchAll(/\b[A-Z][A-Za-z0-9_]*\b/g)) {
    if (declarations.has(match[0]) && !locallyBound.has(match[0])) referenced.add(match[0]);
  }
  return [...referenced];
}

/**
 * Remove block and line comments so scans see only code. Every regex scan
 * over TypeScript text in this codebase goes through this first — a JSDoc
 * example mentioning `import("some-pkg")` or a type name must never count
 * as a reference (the generator, the docs closure, and the typechecker's
 * npm scan all share this).
 */
export function stripComments(text: string): string {
  return text.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/\/\/[^\n]*/g, "");
}

/**
 * A mounted capability as a synthetic graph declaration, so `typeSlice` can
 * walk from a mount into the platform layer: the slice starts at the mount's
 * own types and pulls in the platform declarations they reference, budget
 * and frontier rules identical to a platform root.
 */
export function mountDeclaration(input: {
  declarations: ReadonlyMap<string, ItxApiDeclaration>;
  dottedPath: string;
  instructions?: string;
  types?: string;
}): ItxApiDeclaration {
  // The FULL instructions ride the entry (docs.get promises "instructions and
  // types"); firstSentence is only for the one-line summary below.
  const header = [
    `// Mounted capability "${input.dottedPath}" — call it as itx.${input.dottedPath}.<member>(...).`,
    ...(input.instructions ?? "").split("\n").flatMap((line) => (line ? [`// ${line}`] : [])),
  ];
  const body =
    input.types ??
    `// No types recorded for this mount. itx.${input.dottedPath}.__describe() reports its durable instructions.`;
  return {
    name: input.dottedPath,
    kind: "typeAlias",
    sourceText: [...header, body].join("\n"),
    summary: input.instructions ? firstSentence(input.instructions) : "",
    memberSummaries: {},
    referencedTypeNames: input.types
      ? referencedPlatformTypeNames(input.types, input.declarations)
      : [],
  };
}

/** First sentence of a prose string — what one-line summaries show. */
export function firstSentence(text: string): string {
  const collapsed = text.replaceAll(/\s+/g, " ").trim();
  return collapsed.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? collapsed;
}

/**
 * Score corpus rows against a search query. The mechanism is deliberately
 * dumb — case-insensitive substring matches of query words against each
 * row's haystack — which is why every caller-facing docstring tells agents
 * to pass MANY related words: recall comes from the query, not the engine.
 */
export function searchScore(query: string, haystack: string): number {
  const lowered = haystack.toLowerCase();
  const words = [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean),
    ),
  ];
  let score = 0;
  for (const word of words) {
    if (lowered.includes(word)) score += 1;
  }
  return score;
}
