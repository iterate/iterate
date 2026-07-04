# Iterate project repo

This repo is seeded at project creation by the repo stream processor.

The project worker entrypoint is `worker.ts` (TypeScript). The worker build
pipeline bundles it — together with any files it imports and the npm
dependencies in `package.json` — into a loader-ready worker on first use, so
committing a change here changes the running worker on its next use.
