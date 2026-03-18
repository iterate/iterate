---
state: todo
priority: high
size: medium
tags:
  - jonasland
  - deployment
  - fly
  - observability
dependsOn: []
---

# Add streaming log interface for deployment providers

## Scope

- Define a provider-level log streaming interface for deployment backends (Fly, Docker, future providers).
- Support live streaming and optional catch-up read so consumers can receive recent history before tailing.
- Keep API explicit and low-optionality (required params for stream mode, catch-up window/lines, cancellation).
- Implement in `packages/shared/src/jonasland/deployment/*` and wire into `Deployment` façade.
- Add Fly implementation first (using flyctl or API-backed stream), then Docker parity.

## Acceptance criteria

- A typed API exists for log streaming on providers and on `Deployment`.
- API supports:
  - live follow mode
  - optional catch-up (e.g. last N lines or since timestamp) before follow starts
  - cancellation/cleanup without leaked subprocesses
- Fly provider can stream logs in tests/debug scripts without blocking full deployment lifecycle.
- Existing non-streaming `logs()` call remains available and compatible.
- Add at least one focused test (or executable debug harness) proving catch-up + follow behavior.
