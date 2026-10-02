---
status: done
size: medium
---

# What a `run` script writes says who asked for it

Status: done, in review (iterate/iterate#3471). Events a `run` script appends carry `source.onBehalfOf` (the
requester, their grant, the run), from a signed token on the run's cause; Docs reads it. A script's
commit that names no `author` is authored by the requester. Runs a script requests (its own
`itx.cd(path).run`, or a redirect) stay attributed; runs nobody asked for stay the project's. Not
done: Docs checked on a live preview project (the unit test covers it).

## What we saw

Claude Code, over the iterate MCP server as Misha, ran two scripts on the prd `iterate` project
(2026-09-30): a comment on `jams/23-sep.md` and a commit to it.

| What the script wrote          | Recorded as                                | What it should say                 |
| ------------------------------ | ------------------------------------------ | ---------------------------------- |
| `docs/comment-added`           | `source: { origin: "/", cause }`           | Misha, through Claude Code's grant |
| the commit                     | author `iterate <config@iterate.com>`      | Misha                              |
| the `itx/run-requested` itself | `source.principal` Misha, `source.grant` ✓ | (already right)                    |

So Docs shows the comment's author as "/", and git shows the platform as the commit's author. Every
app reading `source.principal` has the same hole: nothing an agent writes through MCP is anyone's.

## Why it happens today

- The runner executes a request **as the kernel**: `#executeRun` runs it under
  `{ principal: null, cause }` (apps/os `iterate-context-durable-object.ts`), on purpose: "the
  loaded script's own `env.ITX` calls are principal-less anyway (loaded code speaks for the
  project), and the request event carries who asked."
- The script is a loaded worker (`executeScript` → `itx.builtins.workers.get`). Its `env.ITX` calls
  get their caller from `ItxEntrypoint.#caller` (`iterate-context.ts`): `principal: null, app: true`.
- `stampCaller` (`caller.ts`) writes `source.principal` and `source.grant` only from the caller.
- A commit with no `author` is `iterate <config@iterate.com>` (`repo/durable-object.ts` `AUTHOR`).

In `Caller`, authority comes from the principal: "Authority is inferred FROM the principal (no
separate scopes/trust field)". So the fix must not just set `principal` on the script's calls:
that would hand a script its requester's authority too (member-only paths, `account` flows), which
is a different change.

## The change

**Attribution, not authority.** A run's writes carry who asked for it; what the script may do
stays exactly what loaded code may do.

1. **`Caller.onBehalfOf`** (new, `caller.ts`): `{ principal, grant, run }`, where `run` is
   `<path>@<offset>` of the `itx/run-requested`. Set only by the platform, like `platform` and
   `delivery`: nothing a client or loaded code sends can set it.
2. **The runner sets it** (`#executeRun`): from the request event's own stamped `source.principal`
   and `source.grant`. A request with no principal (an agent's loop, a schedule, a processor) sets
   nothing: those runs stay the project's, as now.
3. **The script carries it in its cause, signed.** Not in the loaded worker's props: loaded
   isolates are reused by content hash and share one loopback stub, so props would leak one
   requester's name onto the next run. The cause is per call (`callWithCause`, `getItx(cause)`),
   but unsigned by design ("forging it can only make the forger's own request deeper"), so the
   runner puts a SIGNED token in it (`signClaims` with the session signing secret): principal,
   grant, the run's `path@offset`, the project, an expiry past the run's deadline.
   `ItxEntrypoint.#caller` verifies it and sets `Caller.onBehalfOf`; a forged or expired token
   sets nothing. Still `principal: null, app: true`. The token is never stored in an event, only
   what it proves.
4. **`stampCaller` stamps it**: `source.onBehalfOf = { principal, grant, run }`. `source.principal`
   keeps meaning "the caller had this principal's authority".
5. **Commits**: a commit with no `author`, made under `onBehalfOf`, is authored by that principal
   (email as name and address, as Docs' processor already writes co-authors), not `iterate`.
6. **The MCP instructions** say it: what your script writes is attributed to you and your grant,
   as `source.onBehalfOf`.

Readers change one line. Docs' `authorOf` becomes
`source.principal?.email || source.onBehalfOf?.principal.email || … || source.origin`, and the
panel's "/ · Claude Code" becomes "misha · Claude Code".

## Alternatives

- **Stamp `source.principal`/`grant` directly** from `onBehalfOf` (no new source field). Every
  reader gets it for free, but `source.principal` then stops meaning authority: a processor that
  trusts it to gate something would trust a script's write as the person's. Smaller diff, blurrier
  meaning.
- **Run the script as the requester** (set `Caller.principal`). The script could then do whatever
  the person can, not just what loaded code can. Much bigger change; not what we're after.
- **Only `source.cause.parent`** = the run request (iterate/iterate#3442's parent, not set for runs today), and
  let readers look the requester up. No new field, but every reader does a lookup per event.
- **Do nothing in core; agents self-declare** (`via`, commit `author`). Unverifiable, and every app
  re-solves it.

## Open questions

- ~~**A redirected run**~~ carried: the redirect's `run-requested` at the sandbox is appended under
  the script's token, so it is stamped `source.onBehalfOf` and its runner mints a token of its own
  (`requesterOf`). Each run's token is fresh, so a chain of runs keeps the name past one token's
  eleven minutes; the cause's depth limit (8) bounds it.
- **Workers a script spawns** (`itx.workers.get` inside the script) get fresh props, so their writes
  are the project's. Fine, or should `onBehalfOf` follow?
- **A person's own browser session committing** (the Docs page's New doc): today it passes
  `author` itself. Should a commit with no `author` default to the caller's own principal too?
  Same line in the repo facet.
- **Retention/privacy**: the principal is already on the request event, so no new exposure, but
  it now appears on every event a script writes.

## Tests

- e2e (MCP): a `run` script's append carries `source.onBehalfOf` = the token's principal, grant
  and the request's `path@offset`; `source.principal` stays absent.
- e2e: a processor-requested run (the agent loop) and a schedule's run carry no `onBehalfOf`.
- A client append that sends its own `source.onBehalfOf` has it dropped (`stampCaller` already
  drops a writer's `source` but `processor`).
- A script's commit without `author` is authored by the requester; with `author`, as given.
- Docs: a comment from a script shows the person's name, and `via`.

## The plan (poc)

- [x] `Cause.onBehalfOf` (the signed token) through `parseCause`, never in `storedCause` _(cause.ts; never a mark's, never a delivery's)_
- [x] the runner signs it from the request's stamped principal and grant (`#executeRun`) _(`requesterOf`, `mintOnBehalfOf`; a redirect's request passes it on)_
- [x] ~~`ItxEntrypoint.#caller` verifies it~~ the append verifies it into `Caller.onBehalfOf` _(context/built-ins.ts: `#caller` is synchronous and HMAC verification isn't; hops keep the token in the cause)_
- [x] `stampCaller` stamps `source.onBehalfOf`; the SDK's `StreamEvent` source type has it
- [x] a commit with no `author` under `onBehalfOf` is authored by the requester _(repo/durable-object.ts `#authorFor`: the facet runs with the worker's real env, as the secret facet does, so it verifies the token from its running cause; `{ name: email, email }` as apps/docs `authorOf` writes it; a principal without an email keeps the platform's author)_
- [x] the token names its `purpose` _(on-behalf-of.ts: a token of another purpose the same secret signs never verifies as one)_
- [x] Docs' `authorOf` reads it; the MCP instructions say it
- [x] tests: unit (token round trip, stampCaller, forged token ignored) and e2e (an MCP run's append) _(on-behalf-of.test.ts, cause.test.ts, caller.test.ts, docs processor.test.ts, e2e/mcp-project-root.e2e.test.ts)_
- [x] tests: a run a script requests, and one its context redirects, are for the same person; a processor's run is nobody's _(**workers-tests**/context-runs.test.ts)_; an MCP script's commit is authored by the person _(e2e/mcp-project-root.e2e.test.ts)_
- [ ] a schedule's run carries no `onBehalfOf` _(not tested separately: a due schedule's batch is the kernel's append, principal-less, the same `requesterOf` path as the processor's run)_

## Rollout

Core, so with Jonas. The change is additive (a new optional field), readers opt in, and nothing
that reads `source.principal` changes meaning. Old events stay as they were.

## Implementation log

- 2026-09-30: who-asked rides the CAUSE, not the loaded worker's props: loaded isolates are reused
  by content hash and share one loopback `ITX` stub per context, so props would put one requester's
  name on the next run's writes. The cause is per call. It is unsigned by design, hence the token.
- Verified at the append (async), not in `ItxEntrypoint.#caller` (sync). The workerd tests for runs,
  the loop guard, alarm-started runs and wake causes pass unchanged.
- The repo facet does have the signing secret: first-party facets run with the worker's real env
  (first-party-facets.ts), and the secret facet already reads `appConfigOf(this.env)`. Only its
  declared `Env` type was narrow. It reads the config only when a cause carries a token.
- The preview (`pr3471-d709093`) showed a real MCP run's note with `onBehalfOf` naming the person,
  grant and `/@29`, and no `principal`. CI's MCP e2e covers the commit author against the next
  preview. Docs on a live project wasn't checked: the push replaced the preview (and its data) mid-check.
