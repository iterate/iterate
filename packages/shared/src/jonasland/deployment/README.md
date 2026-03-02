# Deployment Provider Contract

This folder defines the provider abstraction for deployment runtimes.

## Core lifecycle

Every provider class must support instance methods:

- `create(input)`
- `attach(deploymentLocator)`
- `destroy()`

`create` provisions infra and returns a `deploymentLocator`.

`deploymentLocator` is a provider-typed data structure returned from `create` that contains enough identity/locator data to later call `attach` and re-bind to that existing deployment.

## Ownership semantics

- Instances initialized via `create` are **owned** and remote infra is destroyed on dispose.
- Instances initialized via `attach` are **attached** and remote infra is kept on dispose.

## Provider responsibilities

For a new provider, implement:

1. Provider create input type

- Include provider-specific fields plus shared fields (`name`, `env`, readiness knobs).

2. Provider deploymentLocator type

- Include stable identity required for attach.
- Must be serializable.

3. Runtime create path

- Provision infra.
- Build `pidnap`, `registry`, and `caddy` clients.
- Return runtime + deploymentLocator.

4. Runtime attach path

- Resolve existing infra from `deploymentLocator`.
- Build the same clients without provisioning.
- Must not delete remote infra when disposed.

5. Runtime destroy path

- Ensure owned deployments can always be torn down best-effort.

## Current provider locator shapes

- Docker: `{ provider: "docker", containerId, name? }`
- Fly: `{ provider: "fly", appName, machineId? }`
