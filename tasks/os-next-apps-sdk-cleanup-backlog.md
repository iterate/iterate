# os-next apps + SDK cleanup backlog

A menu from six read-only audits (2026-09-18) of the apps, the dash, the SDK (`packages/iterate`)
and the os worker. This session did only the clear, no-new-abstraction cleanups; everything else is
parked here, sorted by *why* it was not done.

**Steer (Jonas, 2026-09-18):** the SDK should mostly be React components and hooks, plus one or two
backend functions, and read obviously — un-mysterious. Prefer spelling a thing twice over a shared
helper. Be dubious of consolidation abstractions (a shared vite config, an `appWorker`, a
`startAppRoot`); do the plainly-dead and plainly-wrong first, keep the rest as a list.

## Done this session
- Deleted `packages/ui/src/components/iterate-mark.tsx` — zero references.
- Deleted agents' `stringifyScriptResult` (`apps/agents/src/lib/agent-events.ts`) — exported, no callers.
- Removed the unreachable `!project` branches in agents/notes/voice `projects.$slug.tsx`: the
  loaders now `return context.signInFor(...)` (a redirect that never settles) when the project is
  missing, so the "No projects yet" blocks could never render.
- Styled agents' router error page to match notes/voice (the bare "Could not load Agents" screen).

## Parked — adds an abstraction (don't do without asking)
- Four `vite.config.ts` → one `startAppViteConfig(app)`. *(Jonas called this out directly: don't.)*
- Four `src/worker.ts` → one `appWorker({ entry, home })`.
- Shared `projects.index.tsx`; shared `__root.tsx`/`router.tsx` → `startAppRoot({ title, css })`.
- Step-up `/.auth/login?scope` href → a `StepUp({ next })` component / a single scopes constant.
- `SessionAuthority`/`SessionInput` literals → constructors. *(prefer spelling twice)*
- Move apps/os's streaming-text / composer / ticking clock into `packages/ui` — large, touches apps/os.

## Parked — judgment or product call (yours)
- os-next `worker.ts` `auth.require` gate removal — every path that reaches it is answered upstream;
  needs a curl to an unknown path to prove nothing depends on it.
- `followCommittedSource` (runs in userspace per event) → a platform reaction.
- `secretOwnerOf` hand-inverts the resource-scope grammar → sign the owner into the OAuth state.
- Context machinery dedupe (`built-ins.ts` deps forwarded verbatim, three identical `list` closures).
- AppShell: agents full-reloads on a project switch (no `onNavigate`) despite a client router — real,
  but the fix is in the shell wiring.
- Move `principal.ts` platform internals (`Caller`, `signClaims`, `verifyClaims`, admin compare) out
  of the SDK — aligns with "SDK = components + a couple functions", but a cross-package move.
- SDK↔platform type duplication (`StreamPage`, `FacetSpec`, `Org`/`Project`, …) → import + extend.
- Dash refetches orgs/projects in child loaders after the shell already loaded them.
- Billing card says there is nothing to bill — delete until there is billing?
- "Sessions" is both a sidebar item and an account-menu item — keep one?
- Sessions page re-implements Identifier's copy affordance and carries unused test ids.
- The one-off project-id migration + the 2026-09-14 retired-secret step in `scripts/deploy.ts` —
  deletable once EVERY environment (incl. preview slots) has migrated; verify before removing.
- `version: 2` grant props with no v1 path; `grants.mint(input: unknown)` untyped.
- Consent could pre-tick the project a "Sign in again" named (project hint → `app-session.begin` →
  the authorize view → `authorize.js`).

## Dropped — the audit was wrong (verified 2026-09-18; do NOT re-attempt as "dead")
- `ConsentAnswer` / `IterateSessionApi.consent` — the consent RPC is live (`session.ts`, the oauth
  workers tests, `e2e/support/principal.ts`).
- dash `lib/projects.ts` — `projectsByOrg`, `Org`, `Project` are all in use (`_auth.tsx`,
  `projects/index.tsx`, `dash-breadcrumbs.tsx`).
- agents' `config-worker.ts` — a deployment template installed as a project's `itx.worker` (like
  notes' documented one), not app code; deleting it may break agents on a project host.
- notes' & voice's `/projects` redirects already point at `/projects/$slug` — fixed in #2738.
- the notes-on-its-own-origin spec (`auth.spec.ts`, gated on `NOTES_BASE_URL`) is the only thing
  exercising the config-worker template; deleting it drops that coverage.
