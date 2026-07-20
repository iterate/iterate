---
state: todo
priority: high
size: medium
dependsOn: []
---

# Diagnose Workers RPC clone-version transport failures

The exact-head preview run for PR #2144 returned one 500 while the seeded
project router was resolving its repo-backed counter worker:

`Unable to deserialize cloned data due to invalid or unsupported version.`

The failing request was `a1e4b0b53fdac95c` on `os-preview-3`, trace
`730826de66ef40b26ea5777a86c3ed1f`, at 2026-07-20 20:24 UTC. The trace reached
`RepoDurableObject.getHead` and never entered `StatefulWorkerDurableObject`, so
this was a Workers RPC clone/transport failure before stateful dispatch rather
than a worker-bundler build or asset failure. Vitest's configured CI retry
passed. Five subsequent no-retry runs also passed, including four concurrent
runs, with no error-level events in their exact telemetry window.

This error predates the worker-bundler change and has appeared on other Repo DO
RPC paths. Do not hide it behind a broad retry or couple recovery to the
worker-bundler API.

Done when there is a minimized production-shaped reproduction (or enough
instrumentation to capture the next occurrence), the failing serialization
boundary and payload are identified, and the outcome is either fixed or
modeled with a narrowly bounded, observable recovery justified by the root
cause. The normal error signal must remain clean.
