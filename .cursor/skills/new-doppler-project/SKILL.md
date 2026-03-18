---
name: new-doppler-project
description: Create a new Doppler project for a repo app or service, wire it to inherit from `_shared`, add branch configs, set base secrets, and register the project in `doppler.yaml`. Use when the user adds a new app/service and wants Doppler setup, inheritance, branch configs, or monorepo wiring.
publish: false
---

# New Doppler Project

Set up a new Doppler project for a repo app or service such as `apps/my-new-app`.

## Gather Inputs

Before running commands, confirm:

- Doppler project slug, usually matching the app/service slug such as `my-new-app`
- repo path such as `apps/my-new-app/`
- shared configs to inherit from, normally `_shared/dev`, `_shared/stg`, `_shared/prd`
- developer branch configs to create, if not specified default to `dev_jonas`, `dev_misha`, `dev_rahul`
- whether `APP_CONFIG` should default to `{}` in `dev`, `stg`, and `prd`

If the CLI is already signed in, use that session directly.

Only ask for an explicit `DOPPLER_TOKEN` if:

- the CLI is not authenticated, or
- a required API/CLI operation cannot be completed with the current session

## Defaults

- base project: `_shared`
- base configs: `dev`, `stg`, `prd`
- branch configs: `dev_jonas`, `dev_misha`, `dev_rahul`
- base secret: `APP_CONFIG="{}"`

## Workflow

### 1. Create the project

Run:

```bash
doppler projects create <project-slug>
```

### 2. Make `_shared` configs inheritable

Use the CLI first:

```bash
for env in dev stg prd; do
  doppler configs update "$env" -p _shared --inheritable=true --yes
done
```

### 3. Set inheritance on the new project

```bash
for env in dev stg prd; do
  doppler configs update "$env" -p <project-slug> --inherits="_shared.$env" --yes
done
```

### 4. Disable personal configs

This step is done in the Doppler UI:

1. Open project `<project-slug>`.
2. Open config settings for `dev`.
3. Turn off Personal Configs.
4. Save.

If the user wants parity, repeat for any other configs where personal configs should stay off.

### 5. Create branch configs

```bash
for name in jonas misha rahul; do
  doppler configs create dev_$name -p <project-slug>
done
```

If the user gives a different developer list, use that list exactly.

### 6. Set base secrets

```bash
for env in dev stg prd; do
  doppler secrets set APP_CONFIG "{}" -p <project-slug> -c "$env" --silent
done
```

### 7. Update `doppler.yaml`

In this repo, `doppler.yaml` pins project scope and path only. Do not add `config` there.

Add an entry like:

```yaml
setup:
  - project: <project-slug>
    path: <repo-path>/
```

Example:

```yaml
setup:
  - project: my-new-app
    path: apps/my-new-app/
```

### 8. Run local Doppler setup

From the app or service directory:

```bash
cd <repo-path>
doppler setup
```

Pick:

- project: `<project-slug>`
- config: usually the developer's local config such as `dev_jonas`

### 9. Smoke test

From `<repo-path>` run:

```bash
doppler secrets
doppler secrets get APP_CONFIG
doppler secrets -c dev_jonas
```

## Hard Rules

- Never guess the correct token, config list, or developer names.
- Prefer the authenticated Doppler CLI session over raw API calls when it supports the workflow.
- Prefer placeholders like `<project-slug>` and `<repo-path>` over hard-coded examples in final instructions.
- Match this repo's `doppler.yaml` format: `project` plus `path`, no pinned `config`.
- If editing `doppler.yaml`, preserve existing comments and ordering style.

## Final Checklist

- [ ] Created Doppler project
- [ ] Made `_shared` configs inheritable
- [ ] Configured inheritance for `dev`, `stg`, `prd`
- [ ] Disabled personal configs where needed
- [ ] Created branch configs
- [ ] Set `APP_CONFIG`
- [ ] Added project mapping to `doppler.yaml`
- [ ] Ran `doppler setup`
- [ ] Ran smoke tests

## References

- [Config Inheritance](https://docs.doppler.com/docs/config-inheritance)
- [Branch Configs](https://docs.doppler.com/docs/branch-configs)
- [CLI Reference](https://docs.doppler.com/docs/cli)
- [Monorepo Setup with doppler.yaml](https://docs.doppler.com/docs/environment-based-configuration)
