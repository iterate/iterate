---
description: "Repository layout and directory structure overview"
alwaysApply: true
---

This monorepo uses pnpm workspaces and is organized around a primary app (`apps/os`), reusable packages, example estates, and shared rules. Paths below are relative to the repo root.

### Top-level directories

- **`apps/`**: Product applications.
  - **`apps/os/`**: The main application.
    - **`app/`**: Frontend UI (React + Vite). Co-located `*.test.ts` tests. Uses shadcn styling and our design system rules.
    - **`backend/`**: Cloudflare Worker backend with nodejs-compat. Uses Drizzle ORM against Postgres.
      - Notable configs: `drizzle.config.ts`, `wrangler.jsonc`, `worker-configuration.d.ts`, `vitest.config.ts`.
      - Logging via `apps/os/backend/tag-logger.ts` (do not use `console`).
    - **`sdk/`**: App-specific shared client/server utilities and SDK code.
    - **`evals/`**: Evaluation harness and related utilities.
    - Notable root files: `env.ts` (Cloudflare env import), `react-router.config.ts`, `vite.config.ts`, `vitest.config.ts`, `vitest.eval.config.ts`, `tsconfig.json`, `tsdown.config.ts`, `public/` assets.
- **`packages/`**: Reusable packages published/consumed within the workspace.
  - Examples: `packages/ngrok/`, `packages/sdk/`.
- **`estates/`**: Example estates/templates demonstrating brand- or deployment-specific customizations.
  - Examples: `estates/iterate/`, `estates/garple/`, `estates/sample-pirate/`, `estates/template/`.
  - May include their own `apps/`, `rules/`, and `iterate.config.ts`.
- **`vibe-rules/`**: Source of truth for coding agent rules that generate `AGENTS.md`, `CLAUDE.md`, and `.cursor/rules`.
  - **`rules/`**: Markdown rule files with YAML frontmatter.
  - **`llms.ts`**: Loads rules from `vibe-rules/rules/**.md`.
- **`scripts/`**: Developer scripts and setup helpers.

### Root-level configuration and tooling

- **`package.json`**: Workspace scripts (e.g., `dev`, `build`, `typecheck`, `lint`, `test`). Postinstall runs `vibe-rules` to install agent rules.
- **`pnpm-workspace.yaml`**: Declares workspace packages (`apps/*`, `packages/*`, `estates/*`, `estates/*/apps/*`, `vibe-rules`).
- **`eslint.config.js`**: Lint configuration; imports rules from `vibe-rules/llms.ts`.
- **`docker-compose.yml`**: Development Postgres service for local backend work.
- **`AGENTS.md`, `CLAUDE.md`**: Generated rule bundles for coding agents (do not hand-edit).
- **`README.md`**: Root documentation.

### Conventions and important notes

- **TypeScript**: Strict TS across the repo. Prefer inferred types where possible; use named exports; include `.ts/.js` extensions in relative imports; use `node:` prefix for Node core modules.
- **Tests**: Vitest, with tests colocated next to source files as `*.test.ts`. Prefer inline snapshots. Use idiomatic `vi` helpers for timers/mocks.
- **Design system**: Use shadcn-styled components; keep Tailwind usage minimal and theme-based.
- **React**: Prefer avoiding `useEffect` unless necessary; fetch with query hooks; compute during render when possible.
- **Backend**: Cloudflare Workers with nodejs-compat. Import env from `apps/os/env.ts`. Use `waitUntil()` for background tasks. Use Drizzle for DB access; use transactions for multi-step operations.
- **Logging**: Do not use `console` in backend; use `logger` from `apps/os/backend/tag-logger.ts` and prefer `logger.info`.
- **Naming**: Be explicit and kebab-case files/folders. If a concept is named `SomeThingTemplate`, name the file `some-thing-template.tsx` (do not abbreviate to generic names like `template.tsx`).
- **Workflow**: Before opening PRs, run: `pnpm typecheck`, `pnpm lint`, `pnpm format`, and `pnpm test`.
