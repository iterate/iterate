# Performance playbook

## Measure what people get

Take three captures of the same signed-in route on a deployment: cold direct navigation, warm
direct navigation, and in-app navigation after hydration. A PR preview is the default target.
Its apps are production builds on workers.dev; sign in with the preview's password (the PR
body's `Sign in ↗` link needs an admin's prd sign-in). Local dev serves source modules and rebuilds on demand, so use it for red/green
behavior only, never for timings.

For each capture, record the commit, route, browser, viewport, network and CPU conditions, UTC
window and whether the cache was cold; then the document TTFB and HTML, FCP, LCP (and which
element), INP, CLS, requests and bytes before FCP/LCP, cache status and initiators, console and
page errors, and, for a client, when the `/api` socket opened and when the first live value
arrived. Compare identical URLs.

A Playwright spec is the durable product assertion (PostHog is the field distribution, Cloudflare
telemetry the server-side explanation). For a server-rendered route it:

- creates an authenticated project fixture;
- navigates directly and reads `page.goto()`'s response body;
- asserts meaningful stable UI is in that HTML;
- interacts with the hydrated locator;
- fails on all page and hydration errors.

## Asset caching

Fingerprinted `/assets/*` files may carry a one-year `immutable` cache. Documents and
unhashed files must not. Check the headers on the real deployment:

```sh
curl -sI -H 'accept-encoding: br' https://<app origin>/assets/<file>.js | grep -iE 'cache-control|etag|cf-cache-status'
```

On 2026-09-24, `dash.iterate.com` answered `cache-control: public, max-age=0, must-revalidate`
with an ETag. Every warm visit revalidated each of the sign-in page's 17 modulepreloads, while
Cloudflare still reported `HIT`. A `HIT` is not a warm-load win. What counts is zero requests
from the browser cache. Prove any header change with a warm capture, and prove that nothing
unhashed is in its scope.

## The JS graph

Read the client manifest (`vite build --manifest`) as a graph. Take each route's transitive
static imports and modulepreloads, compute raw, gzip and Brotli totals without double-counting
shared chunks, and flag modules loaded before the route can use them: closed dialogs, editors,
the context view on a page that has no log, and WASM. Put the lazy boundary at the interaction
that needs the code. Add a byte budget only after the current graph is understood.

## Auth, socket, first read

A client's signed-in page waits for three things in turn: `iterate.authenticate()` in
`_auth`'s `beforeLoad`, the capnweb socket, and the first read. Draw that waterfall from the
browser's network panel and time each hop. Avoid a `list()` followed by N per-item reads when one
read can return the view model. Each `useLiveState` subscribes on its own, so repeated reads of
the same value are a candidate for sharing, but only with tests for lifecycle, reconnect, and
isolation across projects.

## Optional heavy runtimes

Editors, script REPLs, WASM and workers must not block the route's stable chrome. Start them at
the smallest interaction, show progress, and fail in a way someone can see.

## Acceptance

Before landing, run the repository's full pre-PR commands and let the preview's E2E tests and Browser specs pass.
Then repeat the captures on the preview. Query that window's Workers Logs for the app's worker
and the platform's. Static assets can bypass the Worker, so browser captures are the evidence
for caching. Explain every error outcome, even when the route eventually loaded.
