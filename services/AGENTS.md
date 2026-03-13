# Services

**Before changing ANY code in a service, consult the first-party docs for the relevant library.** These APIs change frequently and training data is often stale. Use MCP/context7 or the links below.

## First-party docs (MUST consult)

| Library             | Docs                                              | What to check                                                                |
| ------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------- |
| TanStack Start      | https://tanstack.com/start/latest/docs            | SPA mode, server routes, plugin config                                       |
| TanStack Router     | https://tanstack.com/router/latest/docs           | File-based routing, pathless layouts, params, redirects, preloading          |
| TanStack Query      | https://tanstack.com/query/latest/docs            | `useQuery`, `useSuspenseQuery`, invalidation, `QueryClient`                  |
| TanStack Form       | https://tanstack.com/form/latest/docs             | `useForm`, validators, `form.Field`, `form.Subscribe`                        |
| Hono                | https://hono.dev/docs                             | Routing, middleware, `Hono` app, `app.fetch()`, `@hono/node-server`          |
| oRPC                | https://orpc.dev/docs                             | `os.$context`, `ORPCError`, `RPCHandler`, TanStack Query integration         |
| Drizzle ORM         | https://orm.drizzle.team/docs                     | SQLite schema, `text({ mode: "json" })`, `drizzle-kit push/generate`         |
| Vite                | https://vite.dev/guide                            | Config, plugins, middleware mode, `createServer`                             |
| vite-tsconfig-paths | https://github.com/aleclarson/vite-tsconfig-paths | Reads `tsconfig.json` paths so Vite resolves `@/` aliases                    |
| shadcn/ui           | https://ui.shadcn.com/docs                        | Components, forms (TanStack Form integration at `/docs/forms/tanstack-form`) |
| Zod                 | https://zod.dev                                   | Schemas, `.transform()`, `.refine()`, Standard Schema integration            |

## Canonical service stack

Every service (except `egress-service`) uses this stack:

- **Server:** Hono up front (`server.ts` + `src/server/app.ts`). Dev: `tsx server.ts` starts Hono, Vite in middleware mode. Prod: Hono serves static files from `dist/client/`
- **SPA:** TanStack Start in SPA mode (`spa: { enabled: true }`) via `vite.config.ts`
- **Routing:** TanStack Router file-based routing (routes in `src/routes/`)
- **Data fetching:** oRPC via Hono + `@orpc/tanstack-query` + TanStack Query
- **WebSockets:** `@hono/node-ws` with `createNodeWebSocket` + `injectWebSocket(server)`
- **Forms:** TanStack Form + Zod schemas + shadcn Field components from `packages/ui`
- **Database:** Drizzle ORM + better-sqlite3 (resolves to libsql via monorepo override)
- **UI:** shadcn components from `packages/ui` (`@iterate-com/ui`)

## Canonical file structure

```
services/<name>/
  server.ts                # Hono up front: API routes, Vite middleware (dev), static files (prod)
  vite.config.ts           # vite-tsconfig-paths + tanstackStart SPA + tailwind + react
  tsconfig.json
  drizzle.config.ts
  package.json
  AGENTS.md                # Service-specific notes
  src/
    server/
      app.ts               # Hono app: oRPC handler, WebSocket, health. Exports default + injectWebSocket
      router.ts            # oRPC router definition
      db/
        schema.ts          # Drizzle schema + shared Zod schemas
        index.ts           # Drizzle connection
    routes/                # TanStack Start file-based routes (SPA)
      __root.tsx
      _app.tsx             # Pathless layout (sidebar + Outlet)
      _app/
        index.tsx
        ...
    lib/
      orpc.ts              # Browser oRPC client + TanStack Query utils
    components/            # App-specific components
    router.tsx             # TanStack Router config + QueryClient singleton
```

## Service recipe: Hono up front

`server.ts` is the entry point (`tsx server.ts`). Hono handles `/api/*` first (oRPC, WebSockets, health). Then:

- **Dev:** Vite runs in middleware mode under Hono. `vite.config.ts` has `tanstackStart({ spa: true })` + `vite-tsconfig-paths` which handle TanStack Start SPA HTML generation and `@/` path aliases (from `tsconfig.json` paths). Vite HMR works normally.
- **Prod:** Hono serves static files from `dist/client/` with `_shell.html` as the SPA fallback.

`vite-tsconfig-paths` reads `tsconfig.json` `paths` (e.g. `"@/*": ["./src/*"]`) so Vite resolves the same aliases as TypeScript. Single source of truth -- no duplicating aliases in `resolve.alias`.

WebSockets use `@hono/node-ws`: `createNodeWebSocket({ app })` returns `upgradeWebSocket` (for routes) and `injectWebSocket` (called on the Node server after `createAdaptorServer`).

**Important:** `@hono/node-server`'s `createAdaptorServer` (not `serve`) is required -- it provides `c.env.incoming` / `c.env.outgoing` which the Vite middleware bridge needs.

## Key patterns

### QueryClient: single instance

One `QueryClient` created in `router.tsx`, exported and imported by `__root.tsx`. Never create a second instance — the router context and `QueryClientProvider` must share the same cache.

### oRPC errors

Use `ORPCError` from `@orpc/server`, not plain `Error`. This gives proper HTTP status codes:

```ts
throw new ORPCError("NOT_FOUND", { message: "..." });
```

### oRPC client

`@orpc/tanstack-query` with `createTanstackQueryUtils` (not `@orpc/react-query`). Pure SPA — no `createIsomorphicFn`, no `typeof window` checks.

### Sidebar reactivity

Layout route queries a list. Child routes invalidate on mutations:

```ts
queryClient.invalidateQueries({ queryKey: orpc.<resource>.list.key() });
```

No Zustand or other state management — TanStack Query cache is the single source of truth.

### Redirects

Use `throw redirect()` in `beforeLoad`, not `<Navigate>` components. Avoids render flash.

### Forms (TanStack Form + shadcn)

See https://ui.shadcn.com/docs/forms/tanstack-form for the canonical integration pattern. The form components live in `packages/ui` (the shared shadcn package), NOT locally.

**shadcn components from `packages/ui`** used in forms:

- `Field`, `FieldLabel`, `FieldError`, `FieldGroup`, `FieldDescription` — from `@iterate-com/ui/components/field`
- `Input` — from `@iterate-com/ui/components/input`
- `Textarea` — from `@iterate-com/ui/components/textarea`
- `Select`, `SelectTrigger`, `SelectValue`, `SelectContent`, `SelectItem` — from `@iterate-com/ui/components/select`
- `Button` — from `@iterate-com/ui/components/button`
- `Sidebar`, `SidebarProvider`, `SidebarInset`, `SidebarMenu`, etc. — from `@iterate-com/ui/components/sidebar`

Do NOT copy shadcn components locally. Import from `@iterate-com/ui/components/*`. To add new shadcn components, run `pnpm dlx shadcn@latest add <component>` from `packages/ui/`.

**Form wiring pattern** (from shadcn TanStack Form docs):

```tsx
<form.Field
  name="fieldName"
  children={(field) => {
    const isInvalid = field.state.meta.isTouched && !field.state.meta.isValid;
    return (
      <Field data-invalid={isInvalid}>
        <FieldLabel htmlFor={field.name}>Label</FieldLabel>
        <Input
          id={field.name}
          value={field.state.value}
          onBlur={field.handleBlur}
          onChange={(e) => field.handleChange(e.target.value)}
          aria-invalid={isInvalid}
        />
        {isInvalid && <FieldError errors={field.state.meta.errors} />}
      </Field>
    );
  }}
/>
```

- `data-invalid` on `Field` triggers red styling via shadcn CSS
- `aria-invalid` on the control for accessibility
- `FieldError` accepts `errors={field.state.meta.errors}` directly
- For `Select`: use `onValueChange={field.handleChange}` (not `onChange`)
- `validators: { onChange: schema, onSubmit: schema }` for real-time + submit validation
- `form.Subscribe` with `selector` for submit button loading state (`canSubmit`, `isSubmitting`)

**Shared Zod schemas:** Define validation schemas alongside the Drizzle table. Same schema used by oRPC `.input()` (server) and TanStack Form `validators` (client). Use Zod `.transform()` for parsing (e.g. JSON string -> object).

### Drizzle JSON columns

`text({ mode: "json" })` handles serialization. Parse strings in the Zod schema (`.transform(JSON.parse)`), not in the handler.

## Dev commands

```bash
pnpm dev          # NODE_ENV=development tsx server.ts (Hono + Vite middleware)
pnpm build        # vite build (client + server bundles to dist/)
pnpm start        # NODE_ENV=production tsx server.ts (Hono + static files)
pnpm typecheck    # tsc --noEmit
pnpm db:push      # Push schema to SQLite
pnpm db:studio    # Open Drizzle Studio
```
