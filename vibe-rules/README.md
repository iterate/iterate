This folder contains rules for coding agents that operate on our monorepo.

It uses [vibe-tools](https://www.npmjs.com/package/vibe-rules) to convert these rules to popular coding agent formats like `AGENTS.md`, `CLAUDE.md`, and `.cursor/rules`.

This happens in a package post-install script. So each time you run `pnpm i`, the coding agent rules are refreshed.

The generated files themselves are .gitignored.

# Difference to iterate agent's `ContextRule`

The iterate bot uses a similar system called `ContextRules` that are exported from `estates/iterate/iterate.config.ts`

_Eventually_, we are planning for our iterate agents to _be_ filesystem-based agents just like claude, cursor, codex, etc. At that point VibeRules and our own `ContextRules` will converge

A nice intermediary step might be at some point to load context rules into vibe rules (or at least those that are set to always apply).
