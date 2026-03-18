# Shared App Middleware

This folder contains small shared oRPC middleware helpers used by apps that
build their initial context through `defineApp`.

Current helpers:

- `require-header.ts`
  - requires a request header and injects it into `context.headerValues[...]`
- `use-evlog.ts`
  - injects a request-scoped evlog logger and emits one structured request log

`../middleware.ts` stays as the stable public barrel for consumers.
