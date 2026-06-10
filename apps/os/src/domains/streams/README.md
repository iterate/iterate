# Streams Domain

Streams is the OS project-bound adapter around the namespace/path stream runtime
from `@iterate-com/streams`.

OS uses the stable Project ID as the stream namespace for project streams, but
stream paths remain project-local and must not encode `/projects/{projectId}`.

The stream Durable Object itself comes from `@iterate-com/streams` (bound as
`STREAM`); this folder holds the OS adapters (`new-stream-runtime.ts`, the
streams capability, project stream RPC).
