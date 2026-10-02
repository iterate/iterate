// lib.ts — the pure helpers every layer shares, one platform-neutral file (it rides the SDK bundle
// and the Node unit tests, so no cloudflare:workers here):
//   errors  — `codedError` / `errorCode` / `reportIssue` / `forwardIssues`: THE machine-readable
//             error channel
//   release — `releaseRpcSessions`: dispose the Workers-RPC values a round trip reached
//   patch   — `diff` / `applyPatch` / `jsonEqual`: the live-state delta (an RFC 6902 subset)
//   timeout — `withTimeout`: a promise raced against a deadline (code TIMEOUT)
//   bytes   — `bytesToBase64`: bytes to base64 without overflowing the call stack
//   origin  — `isSameOriginBrowserRequest`: may a request spend the cookies it carries;
//             `cookieValueOf`: one cookie out of a `Cookie` header;
//             `sameOriginPath`, `isLocalOrigin`, `resolveContextPath`: origins and paths
//   environment — `deploymentEnvironment`, `environmentTitle`, `environmentFaviconHref`: which
//             deployment (a PR's preview, local dev, production) a page is on, in its browser tab

// ── errors ── THE machine-readable error channel, after cloudflare-os
// (workshop-shared/src/api.ts: plain Error + a `code` own-property via Object.assign, read with
// `"code" in error`). Why this shape and no other: capnweb coerces custom error NAMES to a
// builtin whitelist and drops subclass identity, but preserves ALL own enumerable properties
// across the wire (verified at runtime against @iterate-com/capnweb 0.10.0) — and with
// enhanced_error_serialization (our compat date) own props survive native Workers-RPC hops too.
// So: never classify by `name`, `instanceof`, or message regex across a hop; check the code.
// Human messages stay verbatim and greppable — the code rides beside them, never instead.
// workerd's own stamped flags (`.retryable`, `.overloaded`, `.durableObjectReset`) ride the same
// own-property channel. What a failure is, and whether it is asked again, is one model
// (docs/engineering-invariants.md#failures-and-retries): a code is an expected outcome, never
// repeated; the platform's own failure crosses a hop as UNAVAILABLE; and "never retry this" is a
// code (PERMANENT_FAILURE, or the refusal's own), never an invented `retryable: false`.

/** The stable machine-readable codes — SCREAMING_SNAKE, defined once, both ends import this. */
type ErrorCode =
  | "SCHEDULE_LIMIT" // bounded pending/failed scheduled batches per context
  | "INVALID_INPUT"
  | "IDENTITY_CONFLICT" // verified login cannot replace another linked identity
  | "GRANT_NOT_FOUND" // a caller may revoke only a grant in their own inventory
  | "SECRET_NOT_SET" // itx.secrets.delete of a path that holds no secret: already gone, or never set
  | "NO_ITX_EXPRESSION_MATCH" // no rewrite rule matches the call (default-deny)
  | "IDEMPOTENCY_CONFLICT"
  | "OFFSET_CONFLICT" // an input's expected `offset` is not the offset it would land at
  | "EVENT_TOO_LARGE" // one event's serialized body is over the append ceiling (stream.ts EVENT_BODY_MAX_CHARS)
  | "REDUCE_CHECKPOINT_TOO_LARGE" // a reduce's state would not fit one storage cell (stream/processor.ts)
  | "EVENT_UNREADABLE" // a stored row's body is not JSON — `data.offset` names it (stream.ts read)
  | "STREAM_PAUSED"
  | "INVALID_CONTEXT" // a context name / project id the codec refuses (core/os context/paths.ts `DurableObjectNameCodec`) — coded, so it survives the hop
  | "EXPRESSION_TOO_LONG" // a STRING itx expression over ITX_EXPRESSION_STRING_MAX_CHARS — pass the parsed form
  | "FACET_SOURCE_TOO_LARGE" // a facet's literal source, or a rule's target, over 1 MiB (worker-loader.ts FACET_SOURCE_MAX_CHARS) — refused on entry
  | "INVALID_CREDENTIALS" // authenticate(): the admin secret did not match, or the credentials named no known kind
  | "UNAUTHENTICATED" // authenticate({ type: "from-server-cookie" }): no session cookie on the request, or a cross-origin browser's request
  | "FORBIDDEN" // projects.get(project): outside the session's reach (a grant narrowed to other projects, or the user is no member of its org); create on a narrowed grant; grants/consent on a session that carries none; organizations.get outside the session's memberships; `cd` in the global namespace (a global context is reached by identity, never by path); a first-party facet off the context the platform hosts it on, or loaded code in the global namespace (core/os first-party-facet-placement.ts)
  | "PROJECT_NAME_TAKEN" // projects.create({ project }): a project of that slug exists in another org
  | "RPC_STUB_OFFLINE" // the rpc stub a row names is neither borrowed nor pager-backed right now — or its lend ended mid-call (recalled, returned, broken; the relay re-codes)
  | "NOT_A_METHOD" // the dotted path's terminal segment is not callable on the target
  | "NO_FACET" // no facet of that name has been loaded into this context
  | "FACET_ABORTED" // the facet instance this call ran on was reset by `itx.facets.abort` (core/os context/facet-host.ts) — its next call starts it fresh
  | "FACET_RESTARTED" // the facet instance this call ran on was restarted by the platform under it — its source or loader identity changed, or another call on it timed out (core/os context/facet-host.ts) — its next call runs on the new instance
  | "FACET_NO_UPGRADE" // a WebSocket upgrade aimed at a facet: a facet answers RPC and plain HTTP, never a socket — sockets terminate at the edge (core/os context/facet-host.ts)
  | "WAIT_TIMEOUT" // waitForEvent expired with no matching event committed
  | "NOT_FAST_FORWARD" // a repo's pull or push without `force` where neither main contains the other (core/os repo/durable-object.ts) — `data` is { ours, theirs }
  | "TIMEOUT" // lib.ts withTimeout: the call did not answer within its deadline
  | "GONE" // a target that says it is gone for good (an HTTP webhook's 410): the delivery halts its row, which an operator's resume reopens
  | "LOOP_LIMIT" // code reacting to code too many hand-offs deep (core/os cause.ts): the act is refused for good, never retried
  | "UNAVAILABLE" // the platform failed the call, not the caller: `data` is { kind, retryAfterMs } — a deploy's reset ("deploy-reset"), a lost connection ("disconnected") or an overload ("overloaded"); an idempotent call may be asked again after retryAfterMs, and an HTTP edge answers it 503 with that Retry-After
  | "PERMANENT_FAILURE"; // a failure no repeat can change (a subscriber's poison event): a delivery halts on it at once instead of climbing its retry ladder (core/os stream/subscription-delivery.ts); a processor's work in flight that died with its host five times, whose revive is refused and recorded as `itx/work-failed` (stream/processor.ts)
// (There is no separate boundary-validation library: the append method's own runtime guards
// throw plain Errors; a client is JUST capnweb, so malformed args surface as ordinary errors.)

/** A plain Error carrying `code` (+ optional `data`) as own enumerable properties. */
export function codedError(code: ErrorCode, message: string, data?: unknown): Error {
  return Object.assign(new Error(message), data === undefined ? { code } : { code, data });
}

/** The code of an error that crossed any number of hops — undefined for uncoded errors. */
export function errorCode(error: unknown): ErrorCode | undefined {
  return typeof error === "object" && error && "code" in error
    ? ((error as { code: unknown }).code as ErrorCode)
    : undefined;
}

/** OUR MARK (core/os cause.ts): what the platform sends — a request, a mail — carries the cause of
 *  the code that sent it here, as JSON; a request that comes back with it resumes its chain. */
export const ITERATE_CAUSE_HEADER = "X-Iterate-Cause";
/** What marks a 508 as an act refused past the loop limit (core/os unavailable.ts). */
export const LOOP_LIMIT_HEADER = "iterate-loop-limit";

/** An answer refused past the loop limit — a 508 marked so — as the LOOP_LIMIT refusal it is,
 *  already recorded where it was met; none for any other answer. */
export async function loopLimitOf(answer: Response): Promise<Error | undefined> {
  if (answer.status !== 508 || !answer.headers.has(LOOP_LIMIT_HEADER)) return undefined;
  return codedError("LOOP_LIMIT", (await answer.text()).trim(), { recorded: true });
}

// reportIssue — the ONE exit for unexpected failures (cloudflare-os error-reporting.ts, minus
// its private Reporter Worker): one bounded console.error line; query event="issue" in Workers
// Logs. A host forwards issues elsewhere too by `forwardIssues(forward)` (core/os posthog.ts:
// PostHog Error Tracking) — capture sites never change. Deliberately NO cloudflare:workers
// import: this file rides the platform-neutral SDK bundle. Reporting must never disturb the
// caller — armored end to end; worst case it prints nothing.

// Bounds verbatim from cloudflare-os: hostile strings get clipped, never explode a log line.
const MAX = { message: 1024, stack: 16_384, string: 256, attributeKeys: 32 } as const;
type Scalar = string | number | boolean | null; // attribute values stay queryable scalars

/** One reported issue as `reportIssue` prints it, and the value that was caught. */
export type Issue = {
  failureSite: string;
  caught: unknown;
  attributes: Record<string, Scalar>;
};
let forwardIssue: ((issue: Issue) => void) | undefined;

/** Also hand every issue to `forward` (one per isolate; the last call wins). It runs inside
 *  `reportIssue`'s armor: a throw is swallowed. */
export function forwardIssues(forward: (issue: Issue) => void): void {
  forwardIssue = forward;
}

/** Print ONE bounded console.error line for an unexpected failure; never throws. */
export function reportIssue(
  failureSite: string,
  caught: unknown,
  attributes?: Record<string, Scalar | undefined>,
): void {
  try {
    const bounded: Record<string, Scalar> = {};
    for (const [key, value] of Object.entries(attributes || {}).slice(0, MAX.attributeKeys)) {
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
        : typeof caught === "object" && caught
          ? { type: "ObjectThrown" }
          : { type: `${typeof caught}Thrown`, message: String(caught).slice(0, MAX.message) };
    console.error({
      ...bounded, // fixed keys spread last so an attribute can never shadow them
      event: "issue",
      failureSite: failureSite.slice(0, MAX.string),
      code,
      error,
    });
    forwardIssue?.({ failureSite, caught, attributes: bounded });
  } catch {
    // Reporting must never disturb the caller — swallow and move on.
  }
}

// ── release ── a Workers-RPC value (a stub, a call's promise) keeps its session, and the actor at
// its far end, open until disposed.

/** Release each of `rpcSessions`, the last first. The answer they served is already in, so a release
 *  that throws is reported, never made the call's failure. */
export function releaseRpcSessions(rpcSessions: readonly unknown[]): void {
  for (const rpcSession of [...rpcSessions].reverse())
    try {
      // A session-brand value or an RPC result object carries a disposer; a void call's undefined
      // answer, or a plain value, has nothing to release.
      (rpcSession as Partial<Disposable> | undefined)?.[Symbol.dispose]?.();
    } catch (error) {
      reportIssue("itx-expression.release-rpc-session", error);
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
  typeof v === "object" && !!v && !Array.isArray(v);

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
    return s ? (JSON.parse(s) as unknown) : undefined;
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
    let parent = root;
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
    if (timer) clearTimeout(timer);
  }
}

// ── bytes ──

/** Bytes to base64, chunked so a long buffer cannot overflow the call stack's argument list. */
export function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

// ── origin ── the one check that makes an ambient cookie safe to honour (session.ts
// `from-server-cookie`, the issuer's form posts in core/os issuer-pages.ts).

/** Whether `request` may spend the cookies it carries: its `Origin` header is this origin, or absent
 *  (a non-browser client — curl, a script). A browser stamps the page's origin on every WebSocket
 *  handshake, every cross-site fetch and every form POST, so a foreign origin means a foreign site
 *  drove the request with the visitor's cookie riding along. A malformed `Origin` (the literal
 *  `null` of a sandboxed document included) is foreign. */
export function isSameOriginBrowserRequest(request: Pick<Request, "url" | "headers">): boolean {
  const origin = request.headers.get("origin");
  // oxlint-disable-next-line iterate/simple-truthiness-check -- security: only a truly absent Origin (non-browser client) is trusted; an empty "" Origin header must stay foreign, which a truthiness check would wrongly accept
  if (origin === null) return true;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

/** The value of the cookie `name` in a `Cookie` header, or null. */
export function cookieValueOf(cookieHeader: string | null, name: string): string | null {
  for (const part of (cookieHeader || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return null;
}

/** `next` as a path on `origin`, else "/" — a redirect never leaves the host: `//evil.example`,
 *  `/\evil.example` and an absolute URL all resolve to a foreign origin and fall back to "/". The
 *  issuer's login redirect uses it too (core/os issuer-pages.ts). */
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

/** Resolve a `cd` target against a context's own path — the one resolver every `cd` (the edge
 *  method, the built-in root, the library's relative handles) shares. Absolute ("/agents/x") stands alone; relative
 *  ("agents/x", "../inbox", ".") joins onto `base`. `.` and `..` resolve; the root cannot be
 *  escaped ("/.." is "/"). The result is canonical: leading slash, no trailing slash but for "/". */
export function resolveContextPath(basePath: string, contextPath: string): string {
  const segments: string[] = [];
  for (const seg of `${contextPath.startsWith("/") ? "" : basePath}/${contextPath}`.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") segments.pop();
    else segments.push(seg);
  }
  return `/${segments.join("/")}`;
}

// ── environment ──
/**
 * Which deployment a page is on, told apart in the browser tab: a per-PR preview gets a purple icon
 * with its PR number and a `[pr<N>]` title prefix, local dev a teal icon and `[dev]`, and
 * production keeps the app's own plain logo and its titles untouched, in every client.
 *
 * Read from the page's own hostname, the one fact the Worker, the server render and the browser
 * all agree on, so no env var or config carries it (envs.ts names the hosts):
 * - `pr<N>-<sha7>-<app>.<subdomain>.workers.dev`: a PR's per-commit deployment (scripts/os/preview.ts)
 * - `localhost`, `*.localhost`, `127.0.0.1`: `pnpm dev`
 * - anything else: production (os.iterate.com, dash.iterate.com, agents.iterate.com, …)
 *
 * Rendered by environment-head-content.tsx in every client's root (packages/ui's, and core/os's own
 * copy), and by the OS's `/favicon.svg` (core/os/src/issuer-pages.ts), which the SDK's gate pages
 * link.
 */
export function deploymentEnvironment(hostname: string) {
  const preview = /^(pr(\d+)(?:-[^.]+)?)-[^.-]+\.[^.]+\.workers\.dev$/.exec(hostname);
  // `deployment`: the name every worker of the set shares, the host's first label without its app
  // (`pr2990-a1b2c3d`), which the sign-in page shows so a reader knows which commit they are on
  if (preview) return { kind: "preview" as const, pr: Number(preview[2]), deployment: preview[1]! };
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "127.0.0.1")
    return { kind: "dev" as const };
  return { kind: "production" as const };
}

export type DeploymentEnvironment = ReturnType<typeof deploymentEnvironment>;

/** `Dash` → `[pr2990] Dash` on a preview, `[dev] Dash` locally, `Dash` in production. */
export function environmentTitle(environment: DeploymentEnvironment, title: string) {
  if (environment.kind === "production") return title;
  return `[${environment.kind === "preview" ? `pr${environment.pr}` : "dev"}] ${title}`;
}

/** Production's icon is the app's own file (`productionHref`), byte for byte; preview and dev get
 *  an inline SVG, so no app ships or routes a second file. */
export function environmentFaviconHref(environment: DeploymentEnvironment, productionHref: string) {
  if (environment.kind === "production") return productionHref;
  return `data:image/svg+xml,${encodeURIComponent(environmentFaviconSvg(environment))}`;
}

/**
 * Preview: purple, the PR number in white as large as the square allows (PR numbers run to four
 * digits and more, too many for the corner badge iterate/iterate#2197 drew for single-digit preview slots).
 * Dev: teal, the white iterate mark (core/os/public/iterate-logo.svg's paths).
 */
export function environmentFaviconSvg(
  environment: Exclude<DeploymentEnvironment, { kind: "production" }>,
) {
  if (environment.kind === "dev")
    return `<svg width="500" height="500" viewBox="0 0 500 500" xmlns="http://www.w3.org/2000/svg"><rect width="500" height="500" fill="${FAVICON_BACKGROUNDS.dev}"/><g fill="white" transform="translate(20 20) scale(0.92)"><path d="M264.649 170.149H289.821L286.092 186.904L276.303 233.444L270.709 259.971L263.717 293.015L258.124 320.008L251.131 352.586L249.267 364.687V371.668L249.733 372.133H253.462L259.522 369.806L266.048 365.617L275.371 357.24L282.829 349.328L286.558 345.14L288.888 346.071L294.948 350.725L308 360.498L307.068 362.36L303.339 367.944L296.813 376.322L291.685 382.837L286.558 388.422L282.363 393.076L275.837 399.592L272.108 402.849L267.446 406.573L262.785 409.83L256.725 413.554L247.869 417.742L238.08 420.535L231.554 421H224.096L216.637 420.069L211.51 418.673L206.382 416.811L201.255 413.088L196.594 408.434L192.865 400.988L191.466 394.938L191 389.818V383.768L193.797 365.152L199.857 335.832L207.315 301.392L224.096 223.205L225.028 216.224V206.916L224.562 205.054L222.231 204.123L219.434 203.193L206.382 203.658L196.127 204.589H193.331V178.526L194.263 175.734L258.59 170.615L264.649 170.149Z"/><path d="M264.649 78H268.844L275.836 78.9308L282.362 80.7924L287.49 83.5848L292.151 87.7734L295.414 92.8928L297.278 96.616L299.143 105.924L299.609 113.836L299.143 118.49L298.677 122.213L296.812 128.729L293.549 134.779L290.286 138.502L286.091 141.76L282.362 143.621L278.167 145.018L274.438 145.948L267.912 146.414H260.92L254.394 145.483L249.267 144.087L244.139 141.294L239.944 138.037L236.681 133.383L233.884 127.332L232.486 121.282L232.02 117.559V108.716L232.952 101.735L234.816 95.6852L237.613 90.1004L240.41 86.3772L246.936 82.1886L252.529 79.8616L259.522 78.4654L264.649 78Z"/></g></svg>`;
  const digits = String(environment.pr);
  // A bold sans digit is about 0.58em wide: fill 460 of the 500 across, and no taller than 360.
  const fontSize = Math.min(360, Math.floor(460 / (0.58 * digits.length)));
  // Three digits and more are stretched upright (at most 1.6×) to stay legible at 16px.
  const stretch = Math.min(1.6, 360 / fontSize);
  // Centred: the baseline sits half a digit's height (≈ 0.72em) below the middle.
  const baseline = Math.round((250 + 0.36 * fontSize * stretch) / stretch);
  return `<svg width="500" height="500" viewBox="0 0 500 500" xmlns="http://www.w3.org/2000/svg"><rect width="500" height="500" fill="${FAVICON_BACKGROUNDS.preview}"/><text x="250" y="${baseline}" transform="scale(1 ${Math.round(stretch * 100) / 100})" text-anchor="middle" fill="white" font-family="Arial, Helvetica, sans-serif" font-size="${fontSize}" font-weight="800">${digits}</text></svg>`;
}

const FAVICON_BACKGROUNDS = { preview: "#7C3AED", dev: "#0F766E" };
