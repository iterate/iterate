---
status: in-progress
size: small
---

# A commit says the platform made it, and which client asked

Status: built, awaiting CI and review. Commits the platform makes are committed by `iterate`; a
script's commit for someone ends with `Via:` (the client's name from the admission), `Iterate-Run:`
and, when it names another author, `Requested-by:`. Left: the e2e against a preview (CI).

## Why

Since #3471 a `run` script's commit is authored by the person who asked for the run. But git then
shows only that person: author and committer are both them
(https://github.com/iterate/config/commit/5bd16a6a79afe2b371f58e18bb666bb7cb7b5e5b). Nothing says
the platform wrote the commit, or that Claude Code did the work.

## The shape

```
Author:     misha@nustom.com <misha@nustom.com>
Commit:     iterate <config@iterate.com>

    docs: jams/23-sep.md, a shorter answer

    Via: Claude Code
    Iterate-Run: /@1595
```

1. **Via iterate is the committer.** Every commit the repo facet makes is committed by
   `iterate <config@iterate.com>`. The author is unchanged: the `author` a caller names, else the
   person a script runs for, else `iterate`. Docs' own saves get the same committer.
2. **Via Claude is a `Via:` trailer**: the name of the client the person connected, as they
   approved it on the consent screen (`account/consent-approved`'s `clientName`), or a personal
   access token's name. The platform knows it, the script doesn't choose it.
3. **`Iterate-Run:`** names the run that made the commit, `<path>@<offset>` of its
   `itx/run-requested` (what `source.onBehalfOf.run` says).
4. **`Requested-by:`** when a script names an `author` who isn't the person it runs for, so they
   aren't lost.

Trailers go in the message's last paragraph when that paragraph is already trailers (Docs'
`Co-authored-by:` lines), else in a new one, so git and GitHub read them all as trailers. A commit
no person asked for (a processor's, Docs' saves, the seed) gets no trailers.

## Decisions (made while Misha was away from the keyboard; revisit freely)

- **The client name is stamped at the MCP edge**, the one place that knows it: the validated
  OAuth token names its `clientId`, and the admission already reads the person's account, whose
  `consents` hold `clientId → clientName`. It rides `Caller.client` → `source.client` on the run
  request → `requesterOf` → the token → `source.onBehalfOf.client` → the commit's `Via:`. Only MCP
  sets `Caller.client` for now; the dash and the API don't.
- **`Iterate-Run:` is `<path>@<offset>`, not a dash link.** A link needs the project's slug and
  sign-in origin, which the repo facet would read per commit, and the dash's URL can change. The
  dash opens it as `…/projects/<slug>/contexts/?event=<offset>`. A follow-up can make it a link.
- **No platform-written `Co-authored-by: Claude <noreply@anthropic.com>`**: it would guess an email
  from a client name, wrongly for other clients. An agent can still write its own.
- **`RepoLogEntry` gains `committer`**, so a reader (and the e2e) can see it.

## Plan

- [x] `encodeCommit` takes a committer; the repo facet commits as `iterate` whatever the author _(repo/git-wire.ts; `PLATFORM` in repo/commit-attribution.ts)_
- [x] `parseCommit` / `RepoLogEntry` report the committer _(iterate/api `RepoLogEntry.committer`)_
- [x] a trailers helper: into the last paragraph when it is trailers, else a new one _(`withTrailers`; a client's name is flattened to one line so it can't write a trailer of its own)_
- [x] the admission records the grant's client name (consent's `clientName`, a key's `name`) _(oauth.ts `AccessGrant.clientName`: the latest consent for the token's `clientId`)_
- [x] MCP's caller carries it; `stampCaller` stamps `source.client`; `requesterOf` and the token
      carry it on to `source.onBehalfOf.client` _(mcp.ts, caller.ts, on-behalf-of.ts)_
- [x] the repo facet adds `Via:`, `Iterate-Run:` and `Requested-by:` for a commit made on someone's
      behalf _(repo/durable-object.ts `commitFiles`, `attributionTrailers`)_
- [x] the MCP instructions say so
- [x] tests: the trailers helper; the token with a client; stampCaller's `client`; the MCP e2e's
      commit (committer, `Via:`, `Iterate-Run:`) and one naming another author (`Requested-by:`) _(repo/commit-attribution.test.ts, on-behalf-of.test.ts, caller.test.ts, e2e/mcp-project-root.e2e.test.ts)_

## Implementation log

- The e2e's MCP bearer is a personal access token, so its `Via:` is the key's name ("MCP root
  regression"); an OAuth client's is its consent-screen name.
- Docs' saves (a processor under a delivery, no token) get the `iterate` committer and no trailers,
  so specs/docs' exact commit message still holds.
