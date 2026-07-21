# TanStack Start performance guidance

Use first-party TanStack sources. Check `apps/os/package.json` before applying
an example: OS can pin different Start and Router patch versions, while the
skills in TanStack's source declare the version they target. Experimental APIs
such as deferred hydration require a typecheck, production build, and browser
proof against the pinned version.

## First-party agent skills

TanStack publishes the relevant skills in
[`TanStack/router`](https://github.com/TanStack/router):

- [`start-core`](https://github.com/TanStack/router/blob/main/packages/start-client-core/skills/start-core/SKILL.md)
  and its `execution-model` sub-skill for isomorphic and client/server bounds;
- [`react-start`](https://github.com/TanStack/router/blob/main/packages/react-start/skills/react-start/SKILL.md)
  for the React-specific Start surface;
- Router's [`code-splitting`](https://github.com/TanStack/router/blob/main/packages/router-core/skills/router-core/code-splitting/SKILL.md),
  [`data-loading`](https://github.com/TanStack/router/blob/main/packages/router-core/skills/router-core/data-loading/SKILL.md),
  [`navigation`](https://github.com/TanStack/router/blob/main/packages/router-core/skills/router-core/navigation/SKILL.md),
  and [`SSR`](https://github.com/TanStack/router/blob/main/packages/router-core/skills/router-core/ssr/SKILL.md)
  sub-skills;
- [`router-query`](https://github.com/TanStack/router/blob/main/packages/react-router/skills/compositions/router-query/SKILL.md)
  for coordinating Router loaders with TanStack Query;
- TanStack's repository-local
  [`bundle-size-optimization`](https://github.com/TanStack/router/blob/main/skills/bundle-size-optimization/SKILL.md)
  skill for its measure-emitted-JavaScript discipline. Its benchmark commands
  are specific to TanStack's repository, not OS.

There is no need to install an unofficial aggregate Start skill. Read the
specific first-party skill for the mechanism being changed, then verify it
against OS's installed package versions and production build.

## Warnings to apply in OS

### Preserve SSR until the real browser boundary

- Start SSRs matched routes by default. A parent's `ssr: false` is inherited by
  every descendant and a child cannot make it less restrictive. Do not put it
  on a layout merely because one provider opens a WebSocket.
- Use `ssr: "data-only"` when `beforeLoad` and `loader` are server-safe but the
  component is not. Use `ClientOnly` around the smallest DOM, storage,
  WebSocket, worker, editor, or WASM consumer when the surrounding component is
  server-safe.
- `loader` and `beforeLoad` are isomorphic: they also run in the browser on
  client navigation. Server-only work belongs behind a server function.
- The first restrictive route renders its pending fallback in server HTML and
  keeps it for the pending minimum during hydration. A fast spinner is still a
  lost first paint; assert the literal response HTML contains useful content.

First-party guide: [Selective SSR](https://tanstack.com/start/latest/docs/framework/react/guide/selective-ssr).

### Split route UI without delaying data

- Keep automatic code splitting enabled and inspect the emitted manifest; do
  not infer splitting from source shape.
- Do not export route component functions. TanStack's transform can then retain
  them in the main bundle instead of the lazy route chunk.
- In manually split files, use `getRouteApi()` instead of importing the route
  object from the critical route file.
- Keep loaders in the critical route reference by default. Splitting a loader
  creates a chunk-fetch-then-data-fetch waterfall and delays both preload and
  render.

First-party guides: [Code Splitting](https://tanstack.com/router/latest/docs/guide/code-splitting)
and [Automatic Code Splitting](https://tanstack.com/router/latest/docs/guide/automatic-code-splitting).

### Coordinate preloading and data caches

- Prefer real `<Link>` elements so Router can preload route code and data on
  intent. OS already sets `defaultPreload: "intent"`; prove additional
  viewport/render preloading against transfer and request budgets.
- `beforeLoad` runs serially from parent to child; loaders and component
  preloads then run in parallel. Do not put slow non-guard work in a parent
  `beforeLoad`.
- Put critical render data in a loader to avoid component-fetch waterfalls.
  Start non-critical Query work without awaiting it only when the streamed or
  explicit loading state is a correct product state.
- Router's preload freshness defaults to 30 seconds. TanStack's Router + Query
  skill requires `defaultPreloadStaleTime: 0` when Query owns freshness, or
  Router can prevent the loader from invoking Query. Audit OS's per-request
  Query client, infinite root snapshot, and invalidation semantics before
  changing the global option; prove request counts and freshness behavior.
- Keep `loaderDeps` minimal. Returning an entire search object causes unrelated
  URL changes to reload data.
- Pending thresholds improve feedback, not latency. Never report a faster
  spinner as a faster route.

First-party guides: [Preloading](https://tanstack.com/router/latest/docs/guide/preloading),
[Data Loading](https://tanstack.com/router/latest/docs/guide/data-loading), and
[External Data Loading](https://tanstack.com/router/latest/docs/guide/external-data-loading).

### Treat deferred hydration as experimental

TanStack's `Hydrate` can preserve SSR HTML while delaying a below-the-fold or
interaction-only subtree's JavaScript and hydration. Consider it only after a
trace shows hydration or initial JavaScript is a bottleneck.

- Keep critical navigation, forms, composer input, and error controls hydrated.
- A split boundary's child must be directly inside a statically imported
  `Hydrate`; hidden wrappers can defeat compiler extraction.
- Nested boundaries hydrate parent-first. A deferred parent can delay an urgent
  interactive child.
- Generated child chunks are not route-modulepreloaded; use measured prefetch
  strategies when later interaction latency warrants them.
- Keep boundary CSS available outside the deferred chunk to avoid unstyled SSR
  content.
- React can hydrate early after surrounding updates, so deferral is a hint, not
  a correctness boundary.

First-party guide: [Deferred Hydration](https://tanstack.com/start/latest/docs/framework/react/guide/deferred-hydration).

### Avoid subscription rerenders

Use Router hook selectors and structural sharing for large search/loader result
objects. Structural sharing only supports JSON-compatible selected values.
Measure React commits before adding selectors; ITX live-state fan-out may be the
actual source instead.

First-party guide: [Render Optimizations](https://tanstack.com/router/latest/docs/guide/render-optimizations).
