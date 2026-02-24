---
state: todo
priority: high
size: medium
dependsOn: []
---

# Export pidnap logs to OTEL logs collector

## Goal

Make pidnap emit structured logs to an OTLP logs endpoint in addition to existing local log files.

## Scope

- Add OTEL log exporter wiring in `packages/pidnap` logger path.
- Support env-configured endpoint/auth headers for collector routing.
- Preserve existing file logs under `/var/log/pidnap/process/*`.
- Include process identity fields (`processSlug`, `state`, `restartCount`) on emitted records.

## Acceptance criteria

- With OTEL env configured, pidnap emits logs visible in collector backend.
- Without OTEL env, pidnap behavior/log files remain unchanged.
- Startup, process lifecycle, restart, and failure logs are exported with stable field names.
- Add test coverage for config-path behavior (enabled vs disabled).
