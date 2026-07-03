# Preview e2e flake hunt

Goal: run the full preview e2e lane against a real preview environment 50
times in a row without a single flake, fixing and documenting every failure
encountered along the way.

Method: deploy this PR's preview slot, then loop
`doppler run --project _shared --config prd -- pnpm preview test --pull-request-number <N>`
from a workstation. Every failure gets a root-cause diagnosis and the smallest
reliable fix, recorded below. A failure resets the consecutive-green counter.

## Run log

(populated as runs complete)

## Flakes found and fixed

(populated as fixes land)
