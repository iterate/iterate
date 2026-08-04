/**
 * Infer a TypeScript type *text* from a JSON value, for LLM eyes — shown next
 * to a truncated preview of an oversized script result so the model knows the
 * full shape without seeing the full payload. The output reads like a .d.ts
 * but is not required to compile (cardinality comments ride along inline).
 *
 * Deliberately hand-rolled rather than quicktype: synchronous, zero deps,
 * Workers-safe, and tuned for this one job (aggressive merging, size budget).
 */

// Internal shape lattice. Object field counts track optionality: a field seen
// in 3 of 5 merged samples renders as `key?: T`.
type Shape =
  | { kind: "null" }
  | { kind: "boolean" }
  | { kind: "number" }
  | { kind: "string"; distinct: Set<string> | null; maxLength: number }
  | { kind: "array"; element: Shape | null; minLength: number; maxLength: number }
  | { kind: "object"; fields: Map<string, { shape: Shape; seen: number }>; samples: number }
  | { kind: "record"; value: Shape; keys: number }
  | { kind: "union"; branches: Shape[] }
  | { kind: "unknown" };

const MAX_UNION_BRANCHES = 3;
const MAX_TRACKED_STRINGS = 5;
const LITERAL_STRING_MAX_LENGTH = 40;
const LONG_STRING_COMMENT_THRESHOLD = 1_000;
const RECORD_KEY_THRESHOLD = 32;
const MAX_INFER_DEPTH = 32;

function inferShape(value: unknown, depth: number): Shape {
  if (depth >= MAX_INFER_DEPTH) return { kind: "unknown" };
  if (value === null || value === undefined) return { kind: "null" };
  if (typeof value === "boolean") return { kind: "boolean" };
  if (typeof value === "number") return { kind: "number" };
  if (typeof value === "string") {
    return {
      kind: "string",
      distinct: value.length <= LITERAL_STRING_MAX_LENGTH ? new Set([value]) : null,
      maxLength: value.length,
    };
  }
  if (Array.isArray(value)) {
    let element: Shape | null = null;
    for (const item of value) {
      const itemShape = inferShape(item, depth + 1);
      element = element === null ? itemShape : mergeShapes(element, itemShape);
    }
    return { kind: "array", element, minLength: value.length, maxLength: value.length };
  }
  if (typeof value === "object") {
    // undefined-valued keys are dropped, matching what JSON.stringify writes
    // to the spill file — they surface as optional fields after merging, not
    // as `| null` branches that the file would contradict.
    const entries = Object.entries(value).filter(([, child]) => child !== undefined);
    const fields = new Map(
      entries.map(([key, child]) => [key, { shape: inferShape(child, depth + 1), seen: 1 }]),
    );
    const shape: Shape = { kind: "object", fields, samples: 1 };
    return maybeRecord(shape, entries.length);
  }
  // Functions, symbols, bigints — JSON.stringify would have dropped or thrown
  // on these anyway; be honest that we don't know.
  return { kind: "unknown" };
}

/** A wide object whose values all merge into one shape is a keyed map, not a
 * struct: render `Record<string, T>` instead of hundreds of fields. */
function maybeRecord(shape: Extract<Shape, { kind: "object" }>, keyCount: number): Shape {
  if (keyCount < RECORD_KEY_THRESHOLD) return shape;
  let merged: Shape | null = null;
  for (const field of shape.fields.values()) {
    merged = merged === null ? field.shape : mergeShapes(merged, field.shape);
    if (merged.kind === "unknown") return shape;
    // A union of struct-ish shapes means the values genuinely differ — keep
    // the object rendering (the char budget will trim it if oversized).
    if (merged.kind === "union" && merged.branches.length >= MAX_UNION_BRANCHES) return shape;
  }
  if (merged === null) return shape;
  return { kind: "record", value: merged, keys: keyCount };
}

function mergeShapes(a: Shape, b: Shape): Shape {
  if (a.kind === "unknown" || b.kind === "unknown") return { kind: "unknown" };
  if (a.kind === b.kind) {
    if (a.kind === "string" && b.kind === "string") {
      let distinct: Set<string> | null = null;
      if (a.distinct !== null && b.distinct !== null) {
        distinct = new Set([...a.distinct, ...b.distinct]);
        // Stop tracking once clearly not an enum-ish field; keeps memory flat.
        if (distinct.size > MAX_TRACKED_STRINGS) distinct = null;
      }
      return { kind: "string", distinct, maxLength: Math.max(a.maxLength, b.maxLength) };
    }
    if (a.kind === "array" && b.kind === "array") {
      const element =
        a.element === null
          ? b.element
          : b.element === null
            ? a.element
            : mergeShapes(a.element, b.element);
      return {
        kind: "array",
        element,
        minLength: Math.min(a.minLength, b.minLength),
        maxLength: Math.max(a.maxLength, b.maxLength),
      };
    }
    if (a.kind === "object" && b.kind === "object") {
      const fields = new Map(a.fields);
      for (const [key, incoming] of b.fields) {
        const existing = fields.get(key);
        fields.set(
          key,
          existing === undefined
            ? incoming
            : {
                shape: mergeShapes(existing.shape, incoming.shape),
                seen: existing.seen + incoming.seen,
              },
        );
      }
      return { kind: "object", fields, samples: a.samples + b.samples };
    }
    if (a.kind === "record" && b.kind === "record") {
      return {
        kind: "record",
        value: mergeShapes(a.value, b.value),
        keys: Math.max(a.keys, b.keys),
      };
    }
    if (a.kind === "union" || b.kind === "union") {
      // handled below via the generic union path
    } else {
      return a; // null/boolean/number: identical kinds carry no extra data
    }
  }
  const branches: Shape[] = [];
  for (const shape of [...unionBranches(a), ...unionBranches(b)]) {
    const mergeableAt = branches.findIndex((existing) => existing.kind === shape.kind);
    if (mergeableAt === -1) branches.push(shape);
    else branches[mergeableAt] = mergeShapes(branches[mergeableAt]!, shape);
  }
  if (branches.length === 1) return branches[0]!;
  if (branches.length > MAX_UNION_BRANCHES) return { kind: "unknown" };
  return { kind: "union", branches };
}

function unionBranches(shape: Shape): Shape[] {
  return shape.kind === "union" ? shape.branches : [shape];
}

// ---------------------------------------------------------------------------
// Rendering

const INDENT = "  ";

type RenderOptions = { maxDepth: number };

function renderShape(shape: Shape, indent: string, options: RenderOptions, depth: number): string {
  if (depth >= options.maxDepth && (shape.kind === "object" || shape.kind === "record")) {
    return "unknown /* nested object */";
  }
  switch (shape.kind) {
    case "null":
      return "null";
    case "boolean":
      return "boolean";
    case "number":
      return "number";
    case "unknown":
      return "unknown";
    case "string": {
      if (shape.distinct !== null && shape.distinct.size <= MAX_TRACKED_STRINGS) {
        return [...shape.distinct].map((value) => JSON.stringify(value)).join(" | ");
      }
      if (shape.maxLength >= LONG_STRING_COMMENT_THRESHOLD) {
        return `string /* up to ~${approximate(shape.maxLength)} chars */`;
      }
      return "string";
    }
    case "array": {
      const lengthComment =
        shape.minLength === shape.maxLength
          ? `/* ${shape.minLength} item${shape.minLength === 1 ? "" : "s"} */`
          : `/* ${shape.minLength}–${shape.maxLength} items each */`;
      if (shape.element === null) return `unknown[] ${lengthComment}`;
      const element = renderShape(shape.element, indent, options, depth + 1);
      const rendered =
        element.includes("\n") || element.includes(" | ") ? `Array<${element}>` : `${element}[]`;
      return `${rendered} ${lengthComment}`;
    }
    case "record": {
      const value = renderShape(shape.value, indent, options, depth + 1);
      return `Record<string, ${value}> /* ${shape.keys} keys */`;
    }
    case "union":
      return shape.branches
        .map((branch) => renderShape(branch, indent, options, depth + 1))
        .join(" | ");
    case "object": {
      if (shape.fields.size === 0) return "{}";
      const inner = indent + INDENT;
      const lines = [...shape.fields].map(([key, field]) => {
        const optional = field.seen < shape.samples ? "?" : "";
        const rendered = renderShape(field.shape, inner, options, depth + 1);
        const renderedKey = IDENTIFIER_KEY.test(key) ? key : JSON.stringify(key);
        return `${inner}${renderedKey}${optional}: ${rendered};`;
      });
      return `{\n${lines.join("\n")}\n${indent}}`;
    }
  }
}

const IDENTIFIER_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function approximate(length: number): string {
  if (length >= 1_000) return `${Math.round(length / 1_000)}k`;
  return String(length);
}

/**
 * Infer a TypeScript type text (the right-hand side of a `type Result = …`)
 * for a JSON value. Never exceeds `maxChars`: rendering retries at shrinking
 * depths (deep subtrees collapse to `unknown`), and as a last resort returns
 * a one-line summary.
 */
export function inferJsonType(value: unknown, options: { maxChars: number }): string {
  const shape = inferShape(value, 0);
  for (let maxDepth = 8; maxDepth >= 1; maxDepth--) {
    const rendered = renderShape(shape, "", { maxDepth }, 0);
    if (rendered.length <= options.maxChars) return rendered;
  }
  return "unknown".slice(0, Math.max(0, options.maxChars));
}
