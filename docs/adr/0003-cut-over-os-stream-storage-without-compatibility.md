# Cut Over OS Stream Storage Without Compatibility

The OS `packages/streams` migration will directly replace the legacy shared stream Durable Object instead of running old and new stream bindings side by side or preserving existing event histories. OS is still in POC stage, so breaking existing stream data is acceptable; the implementation should cut over the binding, port functionality slice by slice, and use the test suite as the convergence target. This keeps the migration focused on the new runtime model instead of spending effort on temporary compatibility and data migration paths.
