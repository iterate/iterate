---
name: new-doppler-project
description: Create a new Doppler project for a repo app or service, wire it to inherit from `_shared`, add branch configs, set base secrets, and register the project in `doppler.yaml`. Use when the user adds a new app/service and wants Doppler setup, inheritance, branch configs, or monorepo wiring.
publish: false
---

# New Doppler Project

Use this when you add a new app or service and need the matching Doppler project.

You are already logged in to Doppler. The only things you need are the project slug and repo path.

## Do This

1. Create the project:

```bash
doppler projects create <project-slug>
```

2. Point `dev`, `stg`, and `prd` at `_shared`:

```bash
for env in dev stg prd; do
  doppler configs update "$env" -p <project-slug> --inherits="_shared.$env" --yes
done
```

`_shared/dev`, `_shared/stg`, and `_shared/prd` are already inheritable. Do not touch `_shared`!

3. Turn Personal Configs off in the Doppler UI. This should always be off. If Doppler created `dev_personal`, that is a sign this setting needs fixing.

4. Create the branch configs we always use:

```bash
doppler configs create dev_jonas -p <project-slug>
doppler configs create dev_misha -p <project-slug>
doppler configs create dev_rahul -p <project-slug>
```

5. Set `APP_CONFIG` to `{}` everywhere:

```bash
for env in dev stg prd; do
  doppler secrets set APP_CONFIG "{}" -p <project-slug> -c "$env" --silent
done
```

6. Add the project to `doppler.yaml`:

```yaml
setup:
  - project: <project-slug>
    path: <repo-path>/
```

In this repo, `doppler.yaml` uses only `project` and `path`. Do not pin a config there.

7. Run local setup from the app or service directory:

```bash
cd <repo-path>
doppler setup --project <project-slug> --config dev_jonas
```

8. Smoke test:

```bash
doppler secrets --only-names
doppler secrets get APP_CONFIG --plain
doppler secrets -c dev_jonas
```

## Rules

- Never ask for or mention a Doppler token.
- Always create exactly `dev_jonas`, `dev_misha`, and `dev_rahul`.
- Always set `APP_CONFIG` to `{}` in `dev`, `stg`, and `prd`.
- Personal Configs should always be off.
- Keep `doppler.yaml` in the repo's existing format.

## References

- [Config Inheritance](https://docs.doppler.com/docs/config-inheritance)
- [Branch Configs](https://docs.doppler.com/docs/branch-configs)
- [CLI Reference](https://docs.doppler.com/docs/cli)
- [Monorepo Setup with doppler.yaml](https://docs.doppler.com/docs/environment-based-configuration)
