---
name: new-doppler-project
description: Create a new Doppler project for a repo app or service, wire it to inherit from `_shared`, add personal dev configs, set minimal app-local secrets, and register it in `doppler.yaml`. Use when the user adds a new app/service and wants Doppler setup, inheritance, per-user dev configs, or monorepo wiring.
publish: false
---

# New Doppler Project

Use this when you add a new app or service and need the matching Doppler project.

You are already logged in to Doppler. The only things you need are the project slug and repo path.

Keep this simple. Almost everything comes from `_shared`.

The target shape for a new project is:

```dotenv
dev:
APP_CONFIG={}

dev_jonas:

dev_misha:

dev_rahul:

prd:
APP_CONFIG={}
ALCHEMY_PASSWORD=[generate this]
```

Everything else should already be inherited from `_shared`, including:

```dotenv
ALCHEMY_STAGE=${DOPPLER_CONFIG}
```

## Do This

1. Create the project:

```bash
doppler projects create <project-slug>
```

2. Create the configs we use and point them at `_shared`:

```bash
doppler configs create dev_jonas -p <project-slug>
doppler configs create dev_misha -p <project-slug>
doppler configs create dev_rahul -p <project-slug>

doppler configs update dev -p <project-slug> --inherits="_shared.dev" --yes
doppler configs update dev_jonas -p <project-slug> --inherits="_shared.dev_jonas" --yes
doppler configs update dev_misha -p <project-slug> --inherits="_shared.dev_misha" --yes
doppler configs update dev_rahul -p <project-slug> --inherits="_shared.dev_rahul" --yes
doppler configs update prd -p <project-slug> --inherits="_shared.prd" --yes
```

We only use `dev`, personal dev configs, and `prd`. Do not create `stg`.

3. Set the tiny app-local secrets:

```bash
doppler secrets set APP_CONFIG="{}" -p <project-slug> -c dev --silent
doppler secrets set APP_CONFIG="{}" -p <project-slug> -c prd --silent

doppler secrets set ALCHEMY_PASSWORD="$(openssl rand -hex 32)" -p <project-slug> -c prd --silent
```

That is all. Everything else should come from `_shared`.

4. Turn Personal Configs off in the Doppler UI. This should always be off. If Doppler created `dev_personal`, that is a sign this setting needs fixing.

5. Add the project to `doppler.yaml`:

```yaml
setup:
  - project: <project-slug>
    path: <repo-path>/
```

In this repo, `doppler.yaml` uses only `project` and `path`. Do not pin a config there.

6. Run local setup from the app or service directory:

```bash
cd <repo-path>
doppler setup --project <project-slug> --config dev_jonas
```

7. Smoke test:

```bash
doppler secrets --only-names
doppler secrets get APP_CONFIG --plain
doppler run -- env | rg '^(DOPPLER_CONFIG|ALCHEMY_STAGE|ALCHEMY_LOCAL)='
doppler secrets get ALCHEMY_PASSWORD --plain
doppler secrets -c dev_jonas
```

## Rules

- Never ask for or mention a Doppler token.
- Always create exactly `dev_jonas`, `dev_misha`, and `dev_rahul`.
- Always create only `dev`, `dev_jonas`, `dev_misha`, `dev_rahul`, and `prd` unless the user explicitly asks for more.
- `DOPPLER_CONFIG` is the canonical per-config selector, but it is injected by Doppler itself. Never create it as a secret.
- `ALCHEMY_STAGE` should be set to `${DOPPLER_CONFIG}` in `_shared` so `dev_jonas` resolves to `dev_jonas`, `prd` resolves to `prd`, etc.
- For a new project, the app-local template is just `APP_CONFIG={}` in `dev` and `prd`, plus a fresh `ALCHEMY_PASSWORD` in `prd`.
- Always set `APP_CONFIG` to `{}` in `dev` and `prd`.
- Always set a fresh high-entropy `ALCHEMY_PASSWORD` in `prd`.
- Do not add extra app-local secrets unless the app actually needs them.
- If staging comes back later, give `stg` its own distinct password. Do not reuse `dev` or `prd`.
- Personal Configs should always be off.
- Keep `doppler.yaml` in the repo's existing format.

## References

- [Config Inheritance](https://docs.doppler.com/docs/config-inheritance)
- [Branch Configs](https://docs.doppler.com/docs/branch-configs)
- [CLI Reference](https://docs.doppler.com/docs/cli)
- [Monorepo Setup with doppler.yaml](https://docs.doppler.com/docs/environment-based-configuration)
