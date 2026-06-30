# Data modelling rules

- Streams are addressed as `{ projectId, path }`. Use a concrete project id for project-local streams and `projectId: null`/`__null__` for deployment-wide streams. Event payloads should include `projectId` only when that fact itself names a project, such as `project/create-requested`.

# Events

Events ARE the public interface to our system - not an internal implementation detail. There may be helper functions that construct events for you, but they are just that - helpers that wrap the primary interface. We don't hide the events.
