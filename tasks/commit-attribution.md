---
status: in-progress
size: small
---

# A commit says the platform made it, and who asked

Status: spec'd, not started.

## Why

Since #3471 a `run` script's commit is authored by the person who asked for the run, but git shows
only them: author and committer are both the person
(https://github.com/iterate/config/commit/5bd16a6a79afe2b371f58e18bb666bb7cb7b5e5b). Nothing says
the platform made the commit, or that an agent did the work.

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
   person a script runs for, else `iterate`.
2. **`Via:` is the agent's own word**, like a Docs comment's `via`: the MCP instructions and the
   Docs agent guide tell an agent to end its commit message with `Via: <its name>`. The platform
   doesn't write or check it.
3. **`Iterate-Run:`** names the run that made the commit, `<path>@<offset>` of its
   `itx/run-requested`, from the token the repo facet already verifies.
4. **`Requested-by:`** when a script names an `author` who isn't the person it runs for.

The platform's trailers join the message's last paragraph when that paragraph is already trailers
(an agent's `Via:`, Docs' `Co-authored-by:` lines), else start their own, so git and GitHub read
them all as trailers. A commit no person asked for (Docs' saves, a processor's, the seed) gets the
committer and no trailers.

## Decisions (option 2 of the discussion; the verified-client version was #3480, closed)

- **Only `apps/os/src/repo/` changes in core**, plus the MCP instructions' text. A platform-verified
  client name needs it carried from the OAuth admission through the caller, the run request and
  the token (#3480): a core decision for another day.
- **No e2e changes**: #3479 is moving the e2e suites to `test/`. The repo facet's own Node test
  (src/repo/durable-object.test.ts, over the fake git remote) drives a commit under a real token.
  Once #3479 lands, the MCP e2e can assert the committer too.
- **`Iterate-Run:` is `<path>@<offset>`, not a dash link**: the repo facet knows neither the
  project's slug nor its sign-in origin. The dash opens it as `…/contexts/?event=<offset>`.
- **`RepoLogEntry` gains `committer`**, so a reader can see it.

## Plan

- [ ] `encodeCommit` takes a committer; `parseCommit` and `RepoLogEntry` report it
- [ ] the repo facet commits as `iterate`, and adds `Iterate-Run:` and `Requested-by:` for a
      commit made on someone's behalf (a trailers helper beside it)
- [ ] the MCP instructions and packages/docs/AGENTS.md tell an agent to end a commit message with
      `Via: <its name>`
- [ ] tests: the trailers helper; git-wire's committer round trip; the repo facet committing under
      a token (committer, author, trailers after an agent's `Via:`), naming another author
      (`Requested-by:`), and under none (committer only)

## Implementation log
