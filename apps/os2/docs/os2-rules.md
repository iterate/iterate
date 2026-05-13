# Data modelling rules

- You never need to drag around a `projectId` in event payloads. Streams are scoped by a "namespace" and we use the project ID as a namespace for all streams. There are some narrow exceptions for "global" iterate-wide streams in the "global" namespace.
