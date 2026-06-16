# Data modelling rules

- Streams are addressed as `{ projectId, path }`. Use a concrete project id for project-local streams and `projectId: null`/`__null__` for deployment-wide streams. Event payloads should include `projectId` only when that fact itself names a project, such as `project/create-requested`.
