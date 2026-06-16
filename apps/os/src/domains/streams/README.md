# Streams Domain

Streams is the OS domain for project/path event streams.

OS uses the stable Project ID as the owner key for project streams, but
stream paths remain project-local and must not encode `/projects/{projectId}`.

The stream Durable Object is bound as `STREAM`. The lower-level runtime that
used to live in `packages/streams` now lives under `engine/`; OS-facing adapters
stay at the domain boundary (`stream-runtime.ts`, the streams capability, and
project/admin stream RPC).
