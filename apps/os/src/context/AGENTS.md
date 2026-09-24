# Contexts and facets

This code decides what keeps a context Durable Object and the facets it hosts running, so what they bill. The rows that prove a careless facet stops (`apps/os/e2e/context-residency.e2e.test.ts`) wait out real quiet minutes, so they are tagged `slow`: every main push runs them, and a PR only when it turns them on ([slow rows](../../../../docs/testing.md#slow-rows)).

- A change that can alter how long a context or facet stays running, what wakes it, its alarms, its claims or what its birth resets turns the slow rows on: add the `slow-e2e` label to the PR before you push, or run them against its preview once deployed, with `pnpm preview e2e --pr <n> --name <branch> --slow-rows only` from `apps/os` under Doppler `os/preview`, or by dispatching Preview OS with `--input action=e2e --input slow-rows=run`.
