// lib.ts — the pure helpers every layer shares; four concepts, one platform-neutral file (it rides
// the SDK bundle and the node unit lane, so no cloudflare:workers here):
//   errors  — `codedError` / `errorCode` / `reportIssue`: THE machine-readable error channel
//   patch   — `diff` / `applyPatch` / `jsonEqual`: the live-state delta (an RFC 6902 subset)
//   timeout — `withTimeout`: a promise raced against a deadline (code TIMEOUT)
//   origin  — `isSameOriginBrowserRequest`: may a request spend the cookies it carries

// ── errors ── THE machine-readable error channel, after cloudflare-os
// (workshop-shared/src/api.ts: plain Error + a `code` own-property via Object.assign, read with
// `"code" in error`). Why this shape and no other: capnweb coerces custom error NAMES to a
// builtin whitelist and drops subclass identity, but preserves ALL own enumerable properties
// across the wire (verified at runtime against @iterate-com/capnweb 0.10.0) — and with
// enhanced_error_serialization (our compat date) own props survive native Workers-RPC hops too.
// So: never classify by `name`, `instanceof`, or message regex across a hop; check the code.
// Human messages stay verbatim and greppable — the code rides beside them, never instead.
// workerd's own stamped flags (`.retryable`, `.overloaded`, `.durableObjectReset`) ride the same
// own-property channel; honor them rather than inventing a retry taxonomy.

/** The stable machine-readable codes — SCREAMING_SNAKE, defined once, both ends import this. */
type ErrorCode =
  | "INVALID_INPUT"
  | "IDENTITY_CONFLICT" // verified login cannot replace another linked identity
  | "GRANT_NOT_FOUND" // a caller may revoke only a grant in their own inventory
  | "NO_ITX_EXPRESSION_MATCH" // no rewrite rule matches the call (default-deny)
  | "IDEMPOTENCY_CONFLICT"
  | "OFFSET_CONFLICT" // an input's expected `offset` is not the offset it would land at
  | "EVENT_TOO_LARGE" // one event's serialized body is over the append ceiling (stream.ts EVENT_BODY_MAX_CHARS)
  | "REDUCE_CHECKPOINT_TOO_LARGE" // a reduce's state would not fit one storage cell (stream/processor.ts)
  | "EVENT_UNREADABLE" // a stored row's body is not JSON — `data.offset` names it (stream.ts read)
  | "RESERVED_SUBSCRIPTION_NAME" // a raw subscription-configured named `core` (the always-on reduce) — refused at the append door
  | "STREAM_PAUSED"
  | "INVALID_CONTEXT" // a context name / project id the codec refuses (iterate-context.ts `DurableObjectNameCodec`) — coded, so it survives the hop
  | "EXPRESSION_TOO_LONG" // a STRING itx expression over ITX_EXPRESSION_STRING_MAX_CHARS — pass the parsed form
  | "FACET_SOURCE_TOO_LARGE" // a facet's literal source over FACET_SOURCE_MAX_CHARS (worker-loader.ts) — refused at the door
  | "INVALID_CREDENTIALS" // authenticate(): the project token did not verify (bad signature, expired, no secret), the admin secret did not match, or the project secret is not that project's
  | "UNAUTHENTICATED" // authenticate({ type: "from-server-cookie" }): no session cookie on the request, or a cross-origin browser's request
  | "FORBIDDEN" // projects.get(project): the session is bound to another project (a project token, the project secret), or the user is no member of its org; create on a bound session; mintToken/rotateApiKey on a handle no session vended (a loaded worker's env.ITX)
  | "PROJECT_NAME_TAKEN" // projects.create({ project }): a project of that name exists in another org
  | "RPC_STUB_OFFLINE" // the rpc stub a row names is neither borrowed nor pager-backed right now — or its lend ended mid-call (recalled, returned, broken; the relay re-codes)
  | "NOT_A_METHOD" // the dotted path's terminal segment is not callable on the target
  | "NO_FACET" // no facet of that name has been loaded into this context
  | "WAIT_TIMEOUT" // waitForEvent expired with no matching event committed
  | "TIMEOUT"; // lib.ts withTimeout: the call did not answer within its deadline
// (There is no separate boundary-validation library: the append door's own runtime guards
// throw plain Errors; a client is JUST capnweb, so malformed args surface as ordinary errors.)

/** A plain Error carrying `code` (+ optional `data`) as own enumerable properties. */
export function codedError(code: ErrorCode, message: string, data?: unknown): Error {
  return Object.assign(new Error(message), data === undefined ? { code } : { code, data });
}

/** The code of an error that crossed any number of hops — undefined for uncoded errors. */
export function errorCode(error: unknown): ErrorCode | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? ((error as { code: unknown }).code as ErrorCode)
    : undefined;
}

// reportIssue — the ONE exit for unexpected failures (cloudflare-os error-reporting.ts, minus
// its private Reporter Worker): one bounded console.error line; query event="issue" in Workers
// Logs. The Reporter seam stayed out on purpose — when one exists, check an optional env
// binding HERE and waitUntil the dispatch; capture sites never change. Deliberately NO
// cloudflare:workers import: this file rides the platform-neutral SDK bundle. Reporting must
// never disturb the caller — armored end to end; worst case it prints nothing.

// Bounds verbatim from cloudflare-os: hostile strings get clipped, never explode a log line.
const MAX = { message: 1024, stack: 16_384, string: 256, attributeKeys: 32 } as const;
type Scalar = string | number | boolean | null; // attribute values stay queryable scalars

/** Print ONE bounded console.error line for an unexpected failure; never throws. */
export function reportIssue(
  failureSite: string,
  caught: unknown,
  attributes?: Record<string, Scalar | undefined>,
): void {
  try {
    const bounded: Record<string, Scalar> = {};
    for (const [key, value] of Object.entries(attributes ?? {}).slice(0, MAX.attributeKeys)) {
      if (value === undefined) continue;
      bounded[key.slice(0, MAX.string)] =
        typeof value === "string" ? value.slice(0, MAX.string) : value;
    }
    const code = errorCode(caught);
    // The thrown value, bounded — name/message/stack read off an Error; an arbitrary object is
    // never walked.
    const error =
      caught instanceof Error
        ? {
            type: (caught.name || "Error").slice(0, MAX.string),
            message: caught.message.slice(0, MAX.message),
            ...(caught.stack && { stack: caught.stack.slice(0, MAX.stack) }),
          }
        : typeof caught === "object" && caught !== null
          ? { type: "ObjectThrown" }
          : { type: `${typeof caught}Thrown`, message: String(caught).slice(0, MAX.message) };
    console.error({
      ...bounded, // fixed keys spread last so an attribute can never shadow them
      event: "issue",
      failureSite: failureSite.slice(0, MAX.string),
      ...(code === undefined ? {} : { code }),
      error,
    });
  } catch {
    // Reporting must never disturb the caller — swallow and move on.
  }
}

// ── patch ── the LiveView-style delta that rides every live-state change event. `diff` runs at
// the PRODUCER (the processor's reduce, the mini-app helper's set) where old and new value are
// both in hand; the stream forwards the ops verbatim; only CLIENTS apply them. The format is an
// RFC 6902 subset (add / replace / remove, JSON-Pointer paths) so any off-the-shelf json-patch
// library applies our patch payloads — we invent no wire format, we just never emit the exotic ops.

export type PatchOp =
  | { op: "add"; path: string; value: unknown }
  | { op: "replace"; path: string; value: unknown }
  | { op: "remove"; path: string };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const escape = (seg: string | number): string =>
  String(seg).replaceAll("~", "~0").replaceAll("/", "~1");

/** Structural deep-equal over plain JSON values — order-insensitive, unbudgeted (JSON is acyclic).
 *  THE one deep-equal: the live-state diff's "don't emit" test AND the idempotency-body compare
 *  (re-exported through stream/processor.ts). The `Object.hasOwn(b, k)` guard is load-bearing — without
 *  it, two objects with the same key COUNT but different key SETS compare equal. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((v, i) => jsonEqual(v, b[i]));
  if (isRecord(a) && isRecord(b)) {
    const ka = Object.keys(a);
    return (
      ka.length === Object.keys(b).length &&
      ka.every((k) => Object.hasOwn(b, k) && jsonEqual(a[k], b[k]))
    );
  }
  return false;
}

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
  if (jsonEqual(a, b)) return undefined;
  if (Array.isArray(a) && Array.isArray(b)) {
    const shared = Math.min(a.length, b.length);
    let p = 0;
    while (p < shared && jsonEqual(a[p], b[p])) p++;
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

// ── timeout ── race a promise against a deadline. The timer is CLEARED on every exit: a leaked
// timer per call would pin a Durable Object awake. A loss rejects with code TIMEOUT so a caller can
// tell "took too long" from the call's own failure (the DO's facet watchdog aborts the facet on it).
//
// `what` may be a THUNK: a label whose construction is expensive (the facet watchdog prints the whole
// pushed batch) is built ONLY when the deadline is actually lost, off the per-call hot path.

export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  what: string | (() => string),
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              codedError(
                "TIMEOUT",
                `${typeof what === "function" ? what() : what}: no answer in ${ms / 1000}s`,
              ),
            ),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ── origin ── the one check that makes an ambient cookie safe to honour (session.ts
// `from-server-cookie`, the console's POST doors in control-plane.ts).

/** Whether `request` may spend the cookies it carries: its `Origin` header is this origin, or absent
 *  (a non-browser client — curl, a script). A browser stamps the page's origin on every WebSocket
 *  handshake, every cross-site fetch and every form POST, so a foreign origin means a foreign site
 *  drove the request with the visitor's cookie riding along. A malformed `Origin` (the literal
 *  `null` of a sandboxed document included) is foreign. */
export function isSameOriginBrowserRequest(request: Pick<Request, "url" | "headers">): boolean {
  const origin = request.headers.get("origin");
  if (origin === null) return true;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

/** `next` as a path on `origin`, else "/" — a redirect never leaves the host: `//evil.example`,
 *  `/\evil.example` and an absolute URL all resolve to a foreign origin and fall back to "/". The
 *  control plane's login redirect uses it too (control-plane.ts). */
export function sameOriginPath(next: string, origin: string): string {
  try {
    const url = new URL(next, origin);
    return url.origin === origin ? url.pathname + url.search : "/";
  } catch {
    return "/";
  }
}

/** Only plain HTTP loopback origins use development login and client registration. */
export function isLocalOrigin(origin: string) {
  const url = new URL(origin);
  return (
    url.protocol === "http:" &&
    (url.hostname === "localhost" ||
      url.hostname.endsWith(".localhost") ||
      url.hostname === "127.0.0.1")
  );
}
