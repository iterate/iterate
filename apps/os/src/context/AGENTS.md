# Contexts and facets

This code decides what keeps a context Durable Object and the facets it hosts running, so what they bill. The rows that prove a careless facet stops (`apps/os/e2e/context-residency.e2e.test.ts`) wait out real quiet minutes, so they are tagged `slow` and a PR skips them unless it changes a file of `SLOW_ROW_PATHS` (`packages/shared/src/test-support/e2e-policy/budgets.ts`): the facet host, residency, RPC stubs and built-ins here, the context Durable Object, the alarm coordinator, both processors and `apps/os/wrangler.base.jsonc` ([slow rows](../../../../docs/testing.md#slow-rows)).

- A change that can alter how long a context or facet stays running, what wakes it or what its birth resets, but touches none of those files, runs the slow rows anyway: add the `slow-e2e` label to the PR before you push, or run them against its preview once deployed, with `pnpm preview e2e --pr <n> --name <branch> --slow-rows only` from `apps/os` under Doppler `os/preview`, or by dispatching Preview OS with `--input action=e2e --input slow-rows=run`.
- Code that moves such behaviour into a new file adds that file to `SLOW_ROW_PATHS`.
