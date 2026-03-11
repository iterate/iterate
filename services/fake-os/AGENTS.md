# fake-os

Vanilla TanStack Start SPA for prototyping deployment management. No SSR — client-only with server routes for oRPC.

**Before changing ANY code in this app, consult the first-party docs for the relevant library.** These APIs change frequently and training data is often stale. Use MCP/context7 or the links below.

## First-party docs (MUST consult)

| Library         | Docs                                    | What to check                                                                |
| --------------- | --------------------------------------- | ---------------------------------------------------------------------------- |
| TanStack Start  | https://tanstack.com/start/latest/docs  | SPA mode, server routes, plugin config                                       |
| TanStack Router | https://tanstack.com/router/latest/docs | File-based routing, pathless layouts, params, redirects, preloading          |
| TanStack Query  | https://tanstack.com/query/latest/docs  | `useQuery`, `useSuspenseQuery`, invalidation, `QueryClient`                  |
| TanStack Form   | https://tanstack.com/form/latest/docs   | `useForm`, validators, `form.Field`, `form.Subscribe`                        |
| oRPC            | https://orpc.dev/docs                   | `os.$context`, `ORPCError`, `RPCHandler`, TanStack Query integration         |
| Drizzle ORM     | https://orm.drizzle.team/docs           | SQLite schema, `text({ mode: "json" })`, `drizzle-kit push/generate`         |
| Vite            | https://vite.dev/guide                  | Config, plugins, dev server, `resolve.alias`                                 |
| shadcn/ui       | https://ui.shadcn.com/docs              | Components, forms (TanStack Form integration at `/docs/forms/tanstack-form`) |
| Zod             | https://zod.dev                         | Schemas, `.transform()`, `.refine()`, Standard Schema integration            |

## Stack

- **Runtime:** TanStack Start in SPA mode (`spa: { enabled: true }`)
- **Routing:** TanStack Router file-based routing (routes in `src/routes/`)
- **Data fetching:** oRPC server + `@orpc/tanstack-query` + TanStack Query
- **Forms:** TanStack Form + Zod schemas + shadcn Field components
- **Database:** Drizzle ORM + better-sqlite3 (resolves to libsql via monorepo override)
- **UI:** shadcn components from `packages/ui` (`@iterate-com/ui`)
- **IDs:** `typeid-js` with `dpl` prefix for deployments

## Architecture

```
src/
  routes/
    __root.tsx           # HTML shell, QueryClientProvider
    _app.tsx             # Pathless layout: sidebar + Outlet
    _app/
      index.tsx          # Redirect / -> /deployments (beforeLoad)
      deployments/
        index.tsx        # List view
        new.tsx          # Create form (TanStack Form)
        $slug.tsx        # Detail + delete
    api/rpc/$.tsx        # oRPC server route (catch-all)
  server/
    router.ts            # oRPC router definition
    db/
      schema.ts          # Drizzle schema + shared Zod schemas
      index.ts           # DB connection
  lib/
    orpc.ts              # oRPC client + TanStack Query utils
  components/
    app-sidebar.tsx      # shadcn Sidebar
  router.tsx             # TanStack Router + QueryClient singleton
```

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

Layout (`_app.tsx`) queries the deployment list. Child routes invalidate on mutations:

```ts
queryClient.invalidateQueries({ queryKey: orpc.deployments.list.key() });
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

Do NOT copy shadcn components locally. Import from `@iterate-com/ui/components/*`. The shared package has `components.json` pointing aliases to `@iterate-com/ui`. To add new shadcn components, run `pnpm dlx shadcn@latest add <component>` from `packages/ui/`.

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

**Shared Zod schemas:** Define validation schemas in `src/server/db/schema.ts` alongside the Drizzle table. The same schema is used by both the oRPC `.input()` validator (server) and the TanStack Form `validators` (client). Use Zod `.transform()` for parsing (e.g. JSON string -> object) — catches errors as validation messages rather than server crashes.

### Drizzle JSON columns

`text({ mode: "json" })` handles serialization. Parse strings in the Zod schema (`.transform(JSON.parse)`), not in the handler. This way invalid JSON is a validation error, not a server crash.

## Dev

```bash
pnpm dev          # Start on port 3100
pnpm typecheck    # Type check
pnpm db:push      # Push schema to SQLite
pnpm db:studio    # Open Drizzle Studio
```

DB file: `./data/fake-os.db` (gitignored).
