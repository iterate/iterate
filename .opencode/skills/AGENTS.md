# Skills

- Skills live in `.opencode/skills/<skill-name>/SKILL.md` (this folder).
- Public registry only includes skills with frontmatter `publish: true`.
- Website well-known endpoint is served by `apps/iterate-com/backend/worker.ts`.
- Registry data is generated from this folder by `apps/iterate-com/scripts/generate-skills-registry.mjs` (run via `pnpm --dir apps/iterate-com skills:generate`; the iterate-com build and deploy scripts run it automatically). The generator fails loudly if this folder is missing.
- Generated file: `apps/iterate-com/backend/generated/skills-registry.ts` (checked in; regenerate and commit when publishable skills change).
- To use repo skills globally in local agents, run sync from repo root:
  - `pnpm skills:sync`
- To inspect globally installed synced skills:
  - `pnpm skills:list`
- Install one skill:
  - `npx skills add iterate/iterate@<skill-name>`
- Install all iterate skills:
  - `npx skills add iterate/iterate --skill '*'`
