// patch.ts — the LiveView-style delta that rides every live-state change event. `diff` runs at
// the PRODUCER (the processor's reduce, the mini-app helper's set) where old and new value are
// both in hand; the stream forwards the ops verbatim; only CLIENTS apply them. The format is an
// RFC 6902 subset (add / replace / remove, JSON-Pointer paths) so any off-the-shelf json-patch
// library applies our frames — we invent no wire format, we just never emit the exotic ops.

export type PatchOp =
  | { op: "add"; path: string; value: unknown }
  | { op: "replace"; path: string; value: unknown }
  | { op: "remove"; path: string };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const escape = (seg: string | number): string =>
  String(seg).replaceAll("~", "~0").replaceAll("/", "~1");

const equal = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((v, i) => equal(v, b[i]));
  if (isRecord(a) && isRecord(b)) {
    const ka = Object.keys(a);
    return (
      ka.length === Object.keys(b).length &&
      ka.every((k) => Object.hasOwn(b, k) && equal(a[k], b[k]))
    );
  }
  return false;
};

/** Structural diff `a → b`, or undefined when deep-equal (the producer's "don't emit" signal).
 *  Objects recurse per key; arrays get the chat-log fast paths (pure append → `add …/-` ops,
 *  pure tail-truncate → `remove` ops) and are replaced wholesale on any middle divergence —
 *  the LiveView trade: optimize the growing log, full-render the rewrite.
 *  Both sides are JSON-normalized first — the wire is JSON, so the diff must see exactly what
 *  the wire will carry: undefined-valued keys vanish, Dates become their ISO strings, array
 *  holes become null. Diffing what you didn't normalize is how a Date change goes silent. */
export function diff(a: unknown, b: unknown): PatchOp[] | undefined {
  // stringify can itself return undefined (a bare function, toJSON() → undefined) — parse
  // would then throw SyntaxError('"undefined" is not valid JSON'); treat those as absent.
  const json = (v: unknown) => {
    const s = JSON.stringify(v);
    return s === undefined ? undefined : (JSON.parse(s) as unknown);
  };
  return walk(json(a), json(b), "");
}

function walk(a: unknown, b: unknown, path: string): PatchOp[] | undefined {
  if (equal(a, b)) return undefined;
  if (Array.isArray(a) && Array.isArray(b)) {
    const shared = Math.min(a.length, b.length);
    let p = 0;
    while (p < shared && equal(a[p], b[p])) p++;
    if (p === a.length) return b.slice(p).map((value) => ({ op: "add", path: `${path}/-`, value }));
    if (p === b.length)
      return a
        .slice(p)
        .map((_, i) => ({ op: "remove", path: `${path}/${a.length - 1 - i}` }) as const);
    return [{ op: "replace", path, value: b }];
  }
  if (isRecord(a) && isRecord(b)) {
    const ops: PatchOp[] = [];
    for (const k of Object.keys(a))
      if (!Object.hasOwn(b, k)) ops.push({ op: "remove", path: `${path}/${escape(k)}` });
    for (const k of Object.keys(b)) {
      if (!Object.hasOwn(a, k)) ops.push({ op: "add", path: `${path}/${escape(k)}`, value: b[k] });
      else ops.push(...(walk(a[k], b[k], `${path}/${escape(k)}`) ?? []));
    }
    return ops.length ? ops : undefined;
  }
  return [{ op: "replace", path, value: b }];
}

/** Apply a patch non-mutatingly (clone-then-mutate). The client half of `diff` — exported
 *  through the SDK so subscribers need no third-party json-patch dependency. */
export function applyPatch<T>(doc: T, ops: PatchOp[]): T {
  let root: unknown = structuredClone(doc);
  for (const op of ops) {
    if (op.path === "") {
      if (op.op === "remove") throw new Error("applyPatch: cannot remove the document root");
      root = op.value;
      continue;
    }
    const segs = op.path
      .slice(1)
      .split("/")
      .map((s) => s.replaceAll("~1", "/").replaceAll("~0", "~"));
    // Patches arrive over the wire. "__proto__" is refused outright (assigning it invokes the
    // prototype setter, not a property write); other prototype members ("constructor", …) are
    // ordinary keys — traversal below is own-property-only, so the chain is never walked.
    for (const s of segs)
      if (s === "__proto__") throw new Error(`applyPatch: refusing __proto__ in path ${op.path}`);
    const last = segs.pop()!;
    let parent: unknown = root;
    for (const s of segs) {
      parent = Array.isArray(parent)
        ? parent[Number(s)]
        : isRecord(parent) && Object.hasOwn(parent, s)
          ? parent[s]
          : undefined;
      if (parent === undefined) throw new Error(`applyPatch: missing path ${op.path}`);
    }
    if (Array.isArray(parent)) {
      if (op.op === "add") {
        if (last === "-") parent.push(op.value);
        else parent.splice(Number(last), 0, op.value);
      } else if (op.op === "replace") parent[Number(last)] = op.value;
      else parent.splice(Number(last), 1);
    } else if (isRecord(parent)) {
      if (op.op === "remove") delete parent[last];
      else parent[last] = op.value;
    } else throw new Error(`applyPatch: path ${op.path} traverses a non-container`);
  }
  return root as T;
}
