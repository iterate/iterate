---
status: in-progress
size: small
---

# Docs: agents work on docs the way the page does

Status: specified, not built. Step 1 of the agents plan from 2026-09-30 (below): an agent guide, a
pointer to it from the project's own agent instructions, and a comment saying which agent wrote it.

## Why

Jonas, on the 2026-09-29 Tuple call: the point of Docs is two people typing into one markdown doc
while "our agent, not our iterate agent, but like Claude" (Claude Code, with his laptop's context)
works on the same doc through the iterate MCP server. Most of that works today: an MCP script can
read a doc, commit an edit (the doc's processor merges it into the open editors), and append the
same comment events the page does. What's missing is an agent knowing how, and the page saying an
agent wrote a comment. The old apps/docs had the same shape (Claude Code over MCP editing files, a
brief per agent) and its lesson is that the brief is what makes it work.

Not in this step: an `@agent` in a comment waking a project agent (step 2, the config's
`processEvent`, as email reaches agents in configs/default/worker.ts), and agents showing as present
(step 3).

## The plan

- [ ] **The guide**: `packages/docs/AGENTS.md`, for an agent with an `itx` (an MCP `run` script, a
      project agent, loaded code). Short, with scripts that work as written: where docs are, reading
      one, editing one (a commit with `parent`, which merges into the open editors), reading a doc's
      comments (the doc processor's live state), commenting, replying, resolving and reopening, and
      saying which agent you are. The events stay the interface: nothing here is a new API.
- [ ] **Found from the project's own agent instructions**: MCP's instructions already tell an agent
      to read the config repo's `AGENTS.md`. `installDocs` adds a short "Docs" section there pointing
      at the guide (raw.githubusercontent.com, main), once, and creates the file when the config
      has none.
- [ ] **Which agent wrote a comment**: comment events take an optional `via` ("Claude Code"), which
      the reducer keeps on the comment and the panel shows as `misha · Claude Code`. It's what the
      agent says it is; the event's `source.grant` is the connection it really came through.
- [ ] Tests: the reducer keeps `via`, `installDocs` adds the section once (and leaves an
      `AGENTS.md` that has it alone), and the comments spec shows a reply that says `via`.

## Assumptions (made without asking; change them if wrong)

- `via` is self-declared rather than derived from `source.grant`: a page can't name another
  person's grant, and a name the agent chooses reads better than a client id.
- The pointer goes in the config's `AGENTS.md`, not in the platform's MCP instructions: Docs is a
  package a project installs, and the platform shouldn't know about it.
- The guide lives on main, so a project on an older pin reads the newest guide; the events it
  describes are the same.

## Implementation log
