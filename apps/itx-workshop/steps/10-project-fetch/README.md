# Step 10 — the Project Durable Object, and `itx.fetch`

**Adds:** a real platform Durable Object, and the first **built-in capability**. Every
project has a **Project Durable Object** (`ProjectDO`) that owns the project's
egress. A project-scoped itx (the `prj:<id>` context from Step 08) is born with
`fetch` wired as a built-in capability backed by that DO, so `itx.fetch(url)` egresses
through the project.

```ts
// inside a project context:
await itx.fetch("https://example.com/thing");
// → routes to ProjectDO.egress(url) for THIS project; { status, body, viaProject: "prj:<id>" }
```

- `ProjectDO.egress(url, init)` does the actual outbound `fetch` (named `egress`,
  not `fetch`, because a DO's `fetch` is its HTTP entrypoint). One DO per project.
- `ProjectDO.builtinCapabilities(stub)` **defines what a project context is born
  with** — `{ fetch: (url) => stub.egress(url) }`. The project owns _what_ it offers.
- The `ItxDO` decides _which_ contexts get them — only the project-root context
  (`prj:<id>`) — and hands them to the `Itx` constructor as built-in capabilities.
  Agent/sub-contexts inherit `fetch` via the chain (Step 11); own provides shadow it.

We deliberately keep it plain — no egress membrane, no secret substitution. The
point is the **shape**: project egress lives in the Project DO and is handed to the
context as a capability.

**The failure it buys you out of:** capabilities like network egress shouldn't be
ambient globals — they should be objects the project owns and the context is
granted. `itx.fetch` is that grant.

**Run:** `npm run dev`, then `node --experimental-strip-types steps/10-project-fetch/intent.test.ts`.
