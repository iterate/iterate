# Skills

- Skills live in `skills/<skill-name>/SKILL.md`.
- Public registry only includes skills with frontmatter `publish: true`.
- Website well-known endpoint is served by `apps/iterate-com/backend/worker.ts`.
- Registry data is generated from this folder by `apps/iterate-com/scripts/generate-skills-registry.mjs`.
- Generated file: `apps/iterate-com/backend/generated/skills-registry.ts`.
- To use repo skills globally in local agents, run sync from repo root:
  - `pnpm skills:sync`
- To inspect globally installed synced skills:
  - `pnpm skills:list`
- Install one skill:
  - `npx skills add iterate/iterate@<skill-name>`
- Install all iterate skills:
  - `npx skills add iterate/iterate --skill '*'`
