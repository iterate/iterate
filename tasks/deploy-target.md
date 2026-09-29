---
size: medium
---

# deployApp takes a DeployTarget: one named env object, no env map, no per-env callbacks

Status: spec only. Nothing implemented yet.

Replaces closed PR #3201. That PR's `--env`/`DOPPLER_CONFIG` half has since landed on main through other PRs. This is the API cleanup that remains, redone from main.

## Problem

apps/os builds a map with a single entry just to satisfy `deployApp`, then reads each field back out through a callback:

```ts
await deployApp({
  env: options.env,
  envs: { [options.env]: env },
  workerName: (env) => env.workerName,
  servingUrl: (env) => env.baseUrl,
  resources: (env) => env.resources || {},
  smokes: (env) => [...],
});
```

Every caller passes `env.workerName` and `env.baseUrl`, so those are part of the env, not arguments. `resolveEnvContext({ envs, env: name })` has the same shape.

## Shape

- `DeployTarget` (scripts/lib/env-context.ts): an envs.ts entry plus the `name` it was looked up by, with `workerName`, `baseUrl` and optional `resources`. The name has to travel with the object because the vite build runs in another process and looks the env up again by name (`CLOUDFLARE_ENV`).
- `getDeployTarget(name, envs)` (envs.ts) returns `{ ...envs[name], name }`, or throws `Unknown environment "x". Known: …`. The name comes first because it's the thing that matters; `envs` is just the collection to look in.
- `getOsDeployTarget(name)` (envs.ts, was `osEnv`) finds an `osEnvs` entry or a per-commit deployment, named; throws instead of returning `undefined`.
- `previewDeployment(name)` puts `name` on its `os` and on each `apps[x]`.
- `deployApp({ env, dopplerProject, appRoot, appLabel, requiredSecrets?, prepare?, build?, afterDeploy?, smokes, withoutRoutes? })` reads `workerName`, `baseUrl` and `resources` off `env`. `smokes` is a plain array.
- `resolveEnvContext({ env, dopplerProject })` takes a `DeployTarget`. `EnvContext.name` goes; callers read `ctx.env.name`.

## Checklist

- [ ] `DeployTarget` type; `resolveEnvContext` takes one; `EnvContext.name` removed
- [ ] `getDeployTarget(name, envs)` and `getOsDeployTarget(name)` in envs.ts; `osEnv` removed
- [ ] `previewDeployment` names its `os` and `apps` entries
- [ ] `deployApp`: no `envs`, `workerName`, `servingUrl` or `resources`; `smokes` is an array
- [ ] callers: apps/os deploy, start-app `deploy`/`ensureResources`, ci-reports, dummy-petshop, spa
- [ ] `resolveEnvContext` callers: ensure-resources, erase-data, project-seed, seed-instance-secrets, preview.ts, context-sweep, flake-dashboard
- [ ] spa: the checks that compare deployed files with the build move to `afterDeploy`, since the zip's name only exists after the build
- [ ] tests: erase-data.test.ts, preview.test.ts and any others that build an `EnvContext`
- [ ] docs and skills that show the old `deployApp`/`resolveEnvContext` shape

## Decisions

- `dopplerProject` stays a separate argument. It's the same for every env of an app, so putting it on each entry would only repeat it.
- `prepare`/`build`/`afterDeploy` stay functions: they need the Doppler secrets and `cf`, which only exist partway through the deploy.
- apps/os scripts that resolve a context (ensure-resources, erase-data, seed-instance-secrets, …) look up `getDeployTarget(options.env, osEnvs)`, not `getOsDeployTarget`. They keep accepting only `osEnvs` names: ensure-resources on a per-commit name would create resources, and seed-instance-secrets has its own `--deployment` flag for per-commit deployments. Only the ones that already use `osEnv` (deploy, generate-wrangler-config, preview.ts) use `getOsDeployTarget`.
- Not writing `name: "prd"` inside each envs.ts entry: that would repeat each key.
- No behaviour change for prd or preview deploys.
