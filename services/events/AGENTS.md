# services/events

- Keep this file short. `CLAUDE.md` must symlink to this file.
- Contracts live in `services/_contracts/events/index.ts`; domain schemas live in `effect-stream-manager/domain.ts`.
- Before PRs for this service run:
  - `pnpm -C services/events typecheck`
  - `pnpm -C services/events test`
  - `pnpm -C services/events lint:check`
- Prefer adding/adjusting tests in `services/events/src/*.test.ts` when stream behavior changes.
