**Things we super mega care about**

- API schemas / contracts / shape - e.g. what orpc routers exist, what classes and public functions in a library are exposed etc
- Environment variables - they need to be well thought through and designed
- Database schemas and migration
- High level architecture

DO NOT randomly add or modify these things without explicitly discussing and checking with a human. If the change you're reviewing does something like this, please flag it and ask the human to confirm this is good.

**We care A LOT about idiomatic code and first party sources**

- Use your MCP servers to research first party docs and recent example usage in other projects - especially when core project maintainers are involved
- Capture links to relevant docs and examples in comments
- Clone the source code of tools you need in ~/src/github.com/ if needed

**Unless explicitly stated, don't care about backwards compatibility**

**No barrel files for stuff that's just imported around the monorepo**

**The most important thing in a file should be at the top**

- Where possible, put helper functions at the bottom, or in an appropriate library - this may also help you discover helpers you can already use
- DO NOT put tons of random type and interfaces at the top of a file - most of the time they should just be inlined or infered

**You never want to re-export things**
We only use these modules internally. If you're re-exporting stuff, you probably broke the rule on backwards compatibility or barrel files.

**Don't declare or export infrequently used things**

- Don't declare constants that are only used once - just inline them
- Don't put all the variables you need at the top of a function unless there's a good reason

**Write "invisible typescript"**

- Most types can be inferred - use that
- Don't declare types and interfaces in tests unless there's a v good reason
- Don't declare function return types unless there is a good reason (e.g. it's a primary, stable API)

**Do not over-use try/catch**
It's okay for errors to escape! That's what they are for if something is wrong.

**When there is ambiguity on intent, ASK FOR CONFIRMATION**
E.g.: DO NOT guess at which of several env vars you've found in the codebase is correct. DO NOT write stuff like this. Instead, ask the human which they want!

```ts
process.env.JONASLAND_E2E_INGRESS_PROXY_DOMAIN ??
  process.env.INGRESS_PROXY_DOMAIN ??
  DEFAULT_INGRESS_PROXY_DOMAIN;
```



**Comments and docstrings are super important**

- They must give additional context - it's helpful when they give usage examples or point to other places in the codebase
- Comments that just explain what the next line does are dumb
- Docstrings explaining arguments and types and interfaces etc are v helpful for the TS language server

# Naming / Identifiers

Use explicit names.

Don't use all-caps acronyms in identifiers. So makeOrpcUrl instead of makeORPCURL

Make sure identifiers are greppable. For instance, try to re-use the exact term that is used elsewhere in the codebase. E.g. don't create a camel cased wrapper envVarName for ENV_VAR_NAME . Just use ENV_VAR_NAME everywhere, so it's easy to find all references.

Don't use fancy names - just use names that clearly describe what something is. For example an IngressProxyWorker is good - it's an HTTP proxy for inbound traffic that is deployed to cloudflare workers.

# Abstractions

Abstractions need to be easy to explain and well motivated in comments and examples.

We want to have _few_ abstractions.

# Services

Before changing a service, consult first-party docs for the actual libraries in use. In practice that usually means TanStack Start / Router / Query / Form, Hono, oRPC, Drizzle, Vite, shadcn/ui, and Zod.

Canonical service stack:

- Hono up front in `server.ts` / `src/server/app.ts`
- TanStack Start in SPA mode
- TanStack Router file-based routes
- oRPC + `@orpc/tanstack-query`
- TanStack Form + shadcn field components from `packages/ui`
- Drizzle + sqlite/libsql

Service patterns that should stay true:

- Keep a single `QueryClient` instance and share it between router context and `QueryClientProvider`
- Use `ORPCError` for API failures instead of plain `Error`
- Use `throw redirect()` in `beforeLoad` instead of render-time navigation
- Import shadcn components from `@iterate-com/ui/components/*`, not local copies
- For TanStack Form, prefer `validators: { onChange, onSubmit }`, `FieldError errors={field.state.meta.errors}`, and `Select` `onValueChange`
- For Drizzle JSON columns, parse in the Zod schema via `.transform(...)`, not in the handler
