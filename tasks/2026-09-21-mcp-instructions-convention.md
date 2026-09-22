---
state: draft
priority: medium
size: small
tags: [os-next, mcp, agents]
---

# MCP server instructions: the one itx expression that tells a coding agent how this project works

Jonas, 2026-09-21: the convention is not thought through yet — record the idea, do not build it.

## Today

`apps/os-next/src/mcp.ts` `serverInstructions` tells a connecting client three things at
`initialize`: that there is one tool, `run`, and where its scripts execute
(the project root, `/`); that every run is on the project root's log; and which projects the token reaches (so `project` is spelled right the first
time). Nothing tells the client how THIS project wants to be used.

## The idea

The instructions should show the specific itx expression to run that returns how to use this
project — the way a repo's `AGENTS.md` tells a coding agent how the repo works. The agent's first
`run` would be that expression, and what comes back is the project's own guidance.

## Open (the convention)

- Where the guidance lives: `AGENTS.md` at the root of the project's config repo (`itx.repo`)?
  A file the project chooses? Something the config worker answers?
- The expression itself: a fixed spelling every project honours (e.g. reading that file through
  `itx.repos`), or one the project registers?
- Inline the text into the instructions (a read per `initialize`) or only point at the
  expression and let the agent's first call fetch it?
- What a project with no guidance gets.

## Done when

A coding agent that connects to any project can find, in the server's instructions, one
expression to run first, and running it returns how to use that project.
