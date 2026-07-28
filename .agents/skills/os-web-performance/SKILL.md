---
name: os-web-performance
description: Diagnose and improve apps/os loading speed, Core Web Vitals, SSR boundaries, asset caching, bundle waterfalls, hydration, and browser-to-itx startup latency. Use when os.iterate.com feels slow, a route shows generic loading UI, Web Vitals regress, repeat visits revalidate assets, or a performance PR needs production-shaped proof.
---

# OS web performance

Make OS feel immediate without hiding latency, errors, or state divergence.

## Targets

Treat these as p75 aspirations for supported desktop and mobile routes:

| Metric |    Target |
| ------ | --------: |
| TTFB   | <= 400 ms |
| FCP    |  <= 1.0 s |
| LCP    |  <= 1.8 s |
| INP    | <= 100 ms |
| CLS    |   <= 0.03 |

Fingerprint repeat loads should transfer zero asset bytes. A direct route hit
should return meaningful stable chrome or content in its HTML whenever the data
and component are server-safe.

## Workflow

1. Read [references/playbook.md](references/playbook.md). For TanStack route,
   loader, bundle, or hydration work, also read
   [references/tanstack-start.md](references/tanstack-start.md). Classify the
   delay before editing: document/server, asset cache, JS graph, hydration, itx
   read, live subscription, or optional heavy runtime.
2. Capture cold and warm direct navigations plus a client-side navigation. Use
   an isolated headed `agent-browser` session, the Playwright product fixture,
   and production or a preview—not Lighthouse against an unrepresentative dev
   server as the only evidence.
3. Follow the repository's PostHog instructions before field queries. Load the
   CLI agent help, list/install a matching skill, then query field p75s by
   route, device, release, and cold/warm cohort.
4. Inspect the production build manifest and browser network initiators. Count
   direct preloads, Brotli bytes, requests before FCP/LCP, cache status, and
   duplicated/heavy entry modules.
5. Reproduce with a red user-facing test. For SSR work, assert against the
   document response body, then assert the hydrated UI is interactive and free
   of page/hydration errors.
6. Make the narrowest architectural change. Move `ClientOnly` around the actual
   browser resource, lazy-load closed UI, aggregate chatty reads, or defer WASM;
   do not convert a measured problem into an unexplained fallback.
7. Prove the focused test, relevant unit tests, build, typecheck, lint, format,
   and full test suite. Then deploy a preview and repeat the same browser trace.
8. Audit Cloudflare traces and logs for the exact preview window. Zero new
   unexplained warnings/errors and coherent state are release criteria.

## Evidence to report

- environment, route, UTC window, commit, browser/device, cache state;
- cold/warm TTFB, FCP, LCP, INP, CLS, transfer bytes, and request count;
- initial HTML content and hydration result;
- bundle/preload and browser-to-itx waterfall changes;
- Playwright checks, preview URL, trace/log audit, and any remaining budget gap.

Read [references/tooling.md](references/tooling.md) before adding a third-party
performance skill, MCP server, scanner, or CI dependency.
