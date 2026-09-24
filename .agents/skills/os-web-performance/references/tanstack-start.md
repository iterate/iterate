# TanStack Start guidance

Use first-party TanStack sources. Check the app's `package.json` pins
(`@tanstack/react-start`, `@tanstack/react-router`) before applying an example, and prove
experimental APIs with a typecheck, a production build and a browser capture.

## First-party agent skills

In [`TanStack/router`](https://github.com/TanStack/router):

- [`start-core`](https://github.com/TanStack/router/blob/main/packages/start-client-core/skills/start-core/SKILL.md)
  and [`react-start`](https://github.com/TanStack/router/blob/main/packages/react-start/skills/react-start/SKILL.md)
  cover the execution model and the client/server bounds.
- Router's [`code-splitting`](https://github.com/TanStack/router/blob/main/packages/router-core/skills/router-core/code-splitting/SKILL.md),
  [`data-loading`](https://github.com/TanStack/router/blob/main/packages/router-core/skills/router-core/data-loading/SKILL.md)
  and [`SSR`](https://github.com/TanStack/router/blob/main/packages/router-core/skills/router-core/ssr/SKILL.md)
  cover the matching topics.
- [`bundle-size-optimization`](https://github.com/TanStack/router/blob/main/skills/bundle-size-optimization/SKILL.md)
  teaches its measuring discipline. Its commands are TanStack's own and do not run here.

The apps have no TanStack Query, so the Router and Query composition skill does not apply.

## Rules that bite here

### SSR stops at `_auth`

- A parent's `ssr: false` is inherited by every descendant, and a child cannot loosen it. Every
  client's `_auth` is `ssr: false` on purpose, because authentication is in the browser. Moving a
  signed-in page to server rendering means authenticating on the server first. That is a design
  change, not a flag.
- `loader` and `beforeLoad` are isomorphic: on client navigation they run in the browser.
  Server-only work belongs behind a server function.
- The first restrictive route renders its pending component in the server HTML
  (`defaultPendingComponent`, shown after `defaultPendingMs: 300` in each `router.tsx`). A
  faster spinner is not a faster route.
- Guide: [Selective SSR](https://tanstack.com/start/latest/docs/framework/react/guide/selective-ssr).

### Split route UI without delaying data

- Keep automatic code splitting enabled, and verify it in the emitted manifest rather than
  from the source shape.
- Do not export route component functions: the transform may keep them in the main chunk.
- Keep loaders in the critical route file. A split loader fetches its chunk before its data.
- Guide: [Code Splitting](https://tanstack.com/router/latest/docs/guide/code-splitting).

### Preloading

- Every client sets `defaultPreload: "intent"`, so use real `<Link>` elements.
- `beforeLoad` runs parent to child in series; loaders then run in parallel. Keep slow
  non-guard work out of a parent `beforeLoad`.
- Keep `loaderDeps` minimal. Returning the whole search object reloads data on unrelated URL
  changes.
- Guide: [Preloading](https://tanstack.com/router/latest/docs/guide/preloading).

### Deferred hydration and rerenders

Consider [deferred hydration](https://tanstack.com/start/latest/docs/framework/react/guide/deferred-hydration)
only for the server-rendered platform pages, and only after a trace shows hydration is the
bottleneck. Keep forms and error controls hydrated. Before adding router selectors
([render optimizations](https://tanstack.com/router/latest/docs/guide/render-optimizations)),
measure React commits: live-state fan-out is often the real source.
