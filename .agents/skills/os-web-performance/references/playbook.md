# OS performance playbook

## Measure the experience users actually get

Record three paths for the same authenticated fixture and route:

1. cold direct navigation with an empty browser cache;
2. warm direct navigation with the cache retained;
3. in-app navigation after the shell is hydrated.

Use a production build or preview for asset graphs and timings. Local dev is
useful for red/green behavior but its source modules, debug metadata, and rebuild
work are not a production bundle. Always record the commit, route, browser,
viewport, network/CPU conditions, UTC window, and whether the cache was cold.

Capture:

- document TTFB and response HTML;
- FCP, LCP (including the LCP element), INP, CLS, and hydration duration;
- request count and bytes before FCP/LCP, cache status, initiator, and waterfall;
- console/page errors, failed requests, long tasks, and layout shifts;
- WebSocket handshake, first itx query result, and first live snapshot.

Lab timing in an isolated headed or headless browser (Playwriter or Playwright) is useful for comparing cold vs warm loads. Use a headed,
worktree-scoped session and compare identical URLs. Playwright is the durable
product assertion; PostHog is the field distribution; Cloudflare telemetry is
the server-side explanation.

## Inspect the startup graph

Run the OS production build. Parse the Vite manifest as a graph rather than
judging individual chunk names:

- enumerate each route's transitive static imports and direct module preloads;
- calculate raw, gzip, and Brotli totals without double-counting shared chunks;
- flag always-mounted closed UI, mixed constant/heavy modules, duplicate
  libraries, and modules loaded before the route can use them;
- add deterministic budgets only after the current graph is understood.

Common OS examples are the global command palette mounted while closed, route
imports that pull onboarding prompts through a tiny constant, the ITX REPL, and
SQLite/WASM used only after opening a stream mirror. Prefer lazy boundaries at
the interaction that needs the code and split tiny stable constants from heavy
implementations.

## Diagnose by layer

### Document and SSR

Inspect the literal navigation response, not only the post-hydration DOM. In
TanStack Start, a parent's `ssr: false` forces every descendant client-only.
Separate server-safe identity/context from browser-only resources and put
`ClientOnly` around the narrow WebSocket, DOM, worker, or WASM consumer.

A useful Playwright contract is:

- create an authenticated project fixture;
- navigate directly and read `page.goto()`'s response body;
- assert meaningful stable UI is in that HTML;
- interact with the hydrated locator;
- fail on all page and hydration errors.

Do not SSR an itx hook that suspends on the WebSocket. Fetch finite server-safe
identity through a server function, SSR stable layout/content, and let an
explicit client boundary connect. Keep truly browser-only leaves `ssr: false`.

### Browser assets

Fingerprint-named `/assets/*` responses may use a one-year immutable browser
cache. SSR documents and unhashed resources may not. Prove the build inventory
contains only fingerprinted assets under the rule and verify a warm navigation
transfers zero asset bytes, rather than merely seeing Cloudflare `HIT` responses
that still require browser revalidation round trips.

### ITX and live state

Draw the complete browser-to-data waterfall: socket connect/authenticate,
capability lookup, finite reads, fan-out reads, subscription, first snapshot.
Avoid `list()` followed by N status calls when one aggregate capability read can
return the card model. Seed finite route data when it is authoritative, then
transition to a background live subscription without flashing unknown state.

Each `useLiveState` call currently owns its subscription store; repeated reads
of the same capability are a candidate for a shared keyed registry, but only
with explicit lifecycle, eviction, reconnect, and cross-project isolation tests.

### Optional heavy runtimes

SQLite workers, OPFS, editors, REPL compilers, and WASM should not block stable
route chrome. Start them at the smallest interaction boundary, show explicit
progress, and preserve a bounded, observable failure. For stream history, prefer
a server live tail plus cursor history before paying the full browser mirror
startup cost when product semantics permit it.

## Production-shaped acceptance

Before landing, run the repository's full pre-PR commands and preview
Playwright. Repeat cold/warm captures on the preview. Query the exact Cloudflare
window for the HTML Worker, server functions, itx calls, warnings, and errors;
static assets can bypass the Worker, so browser evidence is authoritative for
their cache behavior. Explain every error outcome—do not dismiss noise because
the user-visible route eventually loaded.
