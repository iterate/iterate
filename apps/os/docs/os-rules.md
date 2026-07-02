# Data modelling rules

- Streams are addressed as `{ projectId, path }`. Use a concrete project id for project-local streams and `projectId: null` for deployment-wide streams (encoded as the reserved `global.iterate` host in Durable Object names — `src/next/domains/durable-object-names.ts`). Event payloads should include `projectId` only when that fact itself names a project, such as `project/create-requested`.
