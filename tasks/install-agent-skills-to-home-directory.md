---
state: todo
tags:
  - infrastructure
  - daemon
priority: medium
certainty: high
size: small
difficulty: low
---

# Install Agent Skills to Home Directory

Copy skills from customer repo to user's home directory so they're available across all coding agents (Claude Code, OpenCode, Pi).

## Context

Agent Skills is an open standard (agentskills.io) for giving AI agents specialized capabilities. Skills are folders with a `SKILL.md` file containing YAML frontmatter (`name`, `description`) + markdown instructions.

## Home Directory Locations by Agent

| Agent          | Skills Directory                            |
| -------------- | ------------------------------------------- |
| Claude Code    | `~/.claude/skills/`                         |
| OpenCode       | Reads `~/.claude/skills/` automatically     |
| Pi             | `~/.pi/agent/skills/`                       |
| GitHub Copilot | `~/.copilot/skills/` or `~/.claude/skills/` |

**Key insight:** `~/.claude/skills/` is read by Claude Code, OpenCode, Copilot, and Goose. Only Pi needs a separate copy/symlink.

## Skill Format (Universal)

```markdown
---
name: my-skill-name
description: What this skill does and when to use it
---

# Skill Title

Instructions here...
```

## CLI Tools for Listing Skills

| Agent       | Command                   | Notes                                          |
| ----------- | ------------------------- | ---------------------------------------------- |
| Claude Code | `/skills` (slash command) | Feature request pending; API: `GET /v1/skills` |
| OpenCode    | `opencode agent list`     | Lists agents, not skills specifically          |
| Pi          | None documented           | Check `~/.pi/agent/skills/` manually           |
| Gemini CLI  | `gemini skills list`      | For reference                                  |

## Implementation

From `apps/daemon/entry.ts` or daemon bootstrap endpoint:

1. Read skills from customer repo (e.g., `.claude/skills/` or estate's skills directory)
2. Copy to `~/.claude/skills/` (covers Claude Code, OpenCode, Copilot)
3. Copy/symlink to `~/.pi/agent/skills/` (for Pi)

```typescript
import { homedir } from "node:os";
import { cp, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";

async function installSkills(sourceDir: string) {
  const home = homedir();

  // Claude Code / OpenCode / Copilot
  const claudeSkillsDir = join(home, ".claude", "skills");
  await mkdir(claudeSkillsDir, { recursive: true });
  await cp(sourceDir, claudeSkillsDir, { recursive: true });

  // Pi coding agent
  const piSkillsDir = join(home, ".pi", "agent", "skills");
  await mkdir(piSkillsDir, { recursive: true });
  await cp(sourceDir, piSkillsDir, { recursive: true });
}
```

## Open Questions

- Should we symlink or copy? (Symlinks keep source of truth in repo, copies are more isolated)
- Where do skills live in customer repo? `.claude/skills/` or estate-specific location?
- Should we watch for changes and re-sync?
