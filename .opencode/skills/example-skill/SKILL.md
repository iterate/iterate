---
name: example-skill
description: Minimal smoke-test skill that verifies iterate's skills-registry publishing pipeline end to end.
publish: true
---

# Example Skill

This skill is intentionally minimal. It exists to verify the publishing pipeline: it has `publish: true`, so its presence in the generated registry (`apps/iterate-com/backend/generated/skills-registry.ts`, served at `/.well-known/skills` by the iterate.com worker) confirms the generator and endpoint work.

It also serves as the template for a publishable skill: a directory under `.opencode/skills/` containing a `SKILL.md` whose frontmatter has `name` (matching the directory name), `description`, and `publish: true`.
