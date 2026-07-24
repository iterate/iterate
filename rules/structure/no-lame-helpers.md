---
id: structure/no-lame-helpers
files:
  [
    "**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}",
    "!**/*.{test,spec}.{js,jsx,mjs,cjs,ts,tsx,mts,cts}",
    "!**/{__tests__,test,tests,spec,specs}/**",
  ]
---

# Avoid over-abstracting with lame helpers

Avoid tiny helpers that only serve to hide what's really happening. The worst offenders are single-use, non-exported, single-line helpers, but there are several cases where it'd be far simpler and clearer to just inline the functionality.

Bad - forces the reader to basically read four+ synonyms for "worker build failure" for the sake of zero new information:

```ts
export function workerBuildFailedError(failure: WorkerBuildFailure): WorkerBuildFailedError {
  return new WorkerBuildFailedError(failure.message);
}

// later...
if (!loaded.ok) throw workerBuildFailedError(loaded.failure);
```

Instead just do:

```ts
if (!loaded.ok) throw new WorkerBuildFailedError(loaded.failure.message)
```

