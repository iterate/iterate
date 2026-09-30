# Contexts and facets

This code decides what keeps a context Durable Object and the facets it hosts running, so what they bill. The rows that prove a careless facet stops (`test/vitest/os/context-residency.e2e.test.ts`) wait out real quiet minutes, so they are tagged `slow`: every main push runs them, and a PR only when it turns them on ([slow rows](../../../../docs/testing.md#slow-rows)).

- A change that can alter how long a context or facet stays running, what wakes it, its alarms, its claims or what its birth resets turns the slow rows on: the `slow-e2e` label before you push, or a run against its preview once deployed ([how](../../../../docs/testing.md#slow-rows)).
