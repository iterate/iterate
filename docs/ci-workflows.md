# CI Workflows

CI is documented in [Depot CI](depot-ci.md).

This repo no longer uses the old TypeScript workflow generator. CI workflow
YAML is edited directly in `.depot/workflows/*.yml`, and runtime logic lives in
normal TypeScript scripts under `scripts/ci`.
