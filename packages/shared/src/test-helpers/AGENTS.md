## Shared test helpers

- keep low-level helpers tiny, documented, and runner-agnostic
- prefer one helper per file
- helpers here should be easy to compose and hard to misuse
- do not pull app-specific semantics into this folder unless they are truly shared

## Layering

- low-level primitives live here:
  - free port
  - dev server lifecycle
  - cloudflare tunnel lifecycle
  - temp dir
- test-runner-specific helpers should stay near the owning test suite
- app-specific helpers should stay near the owning app or contract

## API style

- default to plain required params over optional complexity
- prefer argv-style process spawning over shell strings
- prefer async-disposable return values for lifecycle-heavy helpers
- expose only the minimum surface the caller actually needs

## Documentation

- every helper should explain what it manages
- every helper should explain the cleanup behavior
- every helper should explain the smallest intended use case
