---
size: medium
---

# deployApp takes a DeployTarget: one named env object, no env map, no per-env callbacks

Status: done. `deployApp` and `resolveEnvContext` take one named env; every caller and the one test double updated. CI is the remaining check: the preview deploy runs apps/os `deploy.ts` through the new `deployApp`.

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
- `deployApp({ env, dopplerProject, appRoot, appLabel, requiredSecrets?, prepare?, build?, afterDeploy?, smokes, withoutRoutes? })` reads `workerName`, `baseUrl` and `resources` off `env`. `smokes` is a plain array.
- `resolveEnvContext({ env, dopplerProject })` takes a `DeployTarget`. `EnvContext.name` goes; callers read `ctx.env.name`.

## Checklist

- [x] `DeployTarget` type; `resolveEnvContext` takes one; `EnvContext.name` removed _`DeployTarget<E> = E & { name }` in scripts/lib/env-context.ts; `ctx.name` → `ctx.env.name` in ensure-resources, erase-data, context-sweep_
- [x] `getDeployTarget(name, envs)` and `getOsDeployTarget(name)` in envs.ts; `osEnv` removed _both add the name and throw on an unknown one; generate-wrangler-config and preview.ts lost their own undefined checks_
- [x] ~~`previewDeployment` names its `os` and `apps` entries~~ _not needed: `getOsDeployTarget` adds the name to whichever entry it finds_
- [x] `deployApp`: no `envs`, `workerName`, `servingUrl` or `resources`; `smokes` is an array _it reads `workerName`, `baseUrl` and `resources` off `env`_
- [x] callers: apps/os deploy, start-app `deploy`/`ensureResources`, ci-reports, dummy-petshop, spa
- [x] `resolveEnvContext` callers: ensure-resources, erase-data, project-seed, seed-instance-secrets, preview.ts, context-sweep, flake-dashboard
- [x] spa: the checks that compare deployed files with the build move to `afterDeploy`, since the zip's name only exists after the build _calls deploy-helpers `smoke()` directly; `smokes: []`_
- [x] tests: erase-data.test.ts, preview.test.ts and any others that build an `EnvContext` _only erase-data.test.ts builds one: `name` moved into its `env`_
- [x] ~~docs and skills that show the old `deployApp`/`resolveEnvContext` shape~~ _none show it: docs/depot-ci.md, docs/dev-environments.md and the creating-an-app skill only name the functions_

## Decisions

- `dopplerProject` stays a separate argument. It's the same for every env of an app, so putting it on each entry would only repeat it.
- `prepare`/`build`/`afterDeploy` stay functions: they need the Doppler secrets and `cf`, which only exist partway through the deploy.
- apps/os scripts that resolve a context (ensure-resources, erase-data, seed-instance-secrets, …) look up `getDeployTarget(options.env, osEnvs)`, not `getOsDeployTarget`. They keep accepting only `osEnvs` names: ensure-resources on a per-commit name would create resources, and seed-instance-secrets has its own `--deployment` flag for per-commit deployments. Only the ones that already use `osEnv` (deploy, generate-wrangler-config, preview.ts) use `getOsDeployTarget`.
- Not writing `name: "prd"` inside each envs.ts entry: that would repeat each key.
- No behaviour change for prd or preview deploys.

## Implementation notes

- Validated: `pnpm typecheck`, `pnpm lint`, `pnpm knip`, `pnpm format` clean; apps/os `vitest run scripts/` (130 passed, 1 expected fail), scripts `vitest run lib/ ci/context-sweep ci/depot-workflows.test.ts` (213 passed).
- `--env nope` on apps/os, dummy-petshop, spa and dash deploy each fails with the lookup's error before touching Doppler. `viteWranglerConfig("pr3144-a1b2c3d")` still derives the per-commit worker.
- `resolveEnvContext({ env: getDeployTarget("preview", osEnvs), dopplerProject: "os" })` against real Doppler and Cloudflare (read-only): name, secrets and the `os` worker all found.
- No real deploy run locally. The PR's Preview OS "Deploy preview" runs apps/os `deploy.ts` through the new `deployApp`; the prd start-app, spa, petshop and ci-reports deploys only run after merge.
