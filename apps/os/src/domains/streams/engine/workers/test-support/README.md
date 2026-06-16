# Stream Worker Test Support

This folder contains Durable Objects used by the stream-engine worker test
harness and the standalone streams example app.

`StreamProcessorRunner` is intentionally here, not in
`workers/durable-objects`, because `apps/os` production does not bind or use a
standalone StreamProcessorRunner Durable Object. OS domain processors are hosted
by their domain Durable Objects through `StreamProcessorHost`.

Keep new production Durable Object classes under `workers/durable-objects`.
Keep test-only or example-only worker harness classes here.
