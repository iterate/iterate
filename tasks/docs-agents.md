---
status: in-progress
size: small
---

# Docs: agents work on docs the way the page does

Status: built, waiting on CI. The guide (`packages/docs/AGENTS.md`), `installDocs`'s pointer to it in
the config's `AGENTS.md`, and `via` on comments (the panel's `jonas · Claude Code`) are in, with
unit tests and a spec step. Left: steps 2 and 3, and a real Claude Code session using the guide.

## Why

Jonas, on the 2026-09-29 Tuple call: the point of Docs is two people typing into one markdown doc
while "our agent, not our iterate agent, but like Claude" (Claude Code, with his laptop's context)
works on the same doc through the iterate MCP server. Most of that works today: an MCP script can
read a doc, commit an edit (the doc's processor merges it into the open editors), and append the
same comment events the page does. What's missing is an agent knowing how, and the page saying an
agent wrote a comment. The old apps/docs had the same shape (Claude Code over MCP editing files, a
brief per agent) and its lesson is that the brief is what makes it work.

Not in this step: an `@agent` in a comment waking a project agent (step 2, the config's
`processEvent`, as email reaches agents in core/configs/default/worker.ts), and agents showing as present
(step 3).

## The plan

- [x] **The guide** _(`packages/docs/AGENTS.md`, in the package's `files` too)_: `packages/docs/AGENTS.md`, for an agent with an `itx` (an MCP `run` script, a
      project agent, loaded code). Short, with scripts that work as written: where docs are, reading
      one, editing one (a commit with `parent`, which merges into the open editors), reading a doc's
      comments (the doc processor's live state), commenting, replying, resolving and reopening, and
      saying which agent you are. The events stay the interface: nothing here is a new API.
- [x] **Found from the project's own agent instructions** _(`installDocs`, `docsAgentsSection`)_: MCP's instructions already tell an agent
      to read the config repo's `AGENTS.md`. `installDocs` adds a short "Docs" section there pointing
      at the guide (raw.githubusercontent.com, main), once, and creates the file when the config
      has none.
- [x] **Which agent wrote a comment** _(`via` in `comments.ts`, defaulting to null so a newer page reads an older build's threads; `comments-panel.tsx`)_: comment events take an optional `via` ("Claude Code"), which
      the reducer keeps on the comment and the panel shows as `misha · Claude Code`. It's what the
      agent says it is; the event's `source.grant` is the connection it really came through.
- [x] Tests _(`processor.test.ts`, `install.test.ts`, a reply by script in `specs/docs/comments.spec.ts`)_: the reducer keeps `via`, `installDocs` adds the section once (and leaves an
      `AGENTS.md` that has it alone), and the comments spec shows a reply that says `via`.

## Assumptions (made without asking; change them if wrong)

- `via` is self-declared rather than derived from `source.grant`: a page can't name another
  person's grant, and a name the agent chooses reads better than a client id.
- The pointer goes in the config's `AGENTS.md`, not in the platform's MCP instructions: Docs is a
  package a project installs, and the platform shouldn't know about it.
- The guide lives on main, so a project on an older pin reads the newest guide; the events it
  describes are the same.

## Implementation log

- 2026-09-30: `via` is `.default(null)` in the `Comment` schema: the Docs page is often newer than
  a project's pinned processor, and a required field would make the page's live-state parse fail
  (stuck at "Opening…") on every doc of a project on an older pin.
- The spec's agent step reads the thread from the doc processor's live state exactly as the guide
  says, then appends the reply with `via`, so the guide's two central snippets run in CI.
