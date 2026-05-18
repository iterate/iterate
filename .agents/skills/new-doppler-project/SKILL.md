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

preview:

preview_1:
APP_CONFIG_BASE_URL=https://<app>.iterate-preview-1.com

preview_2:
APP_CONFIG_BASE_URL=https://<app>.iterate-preview-2.com

...

preview_9:
APP_CONFIG_BASE_URL=https://<app>-preview-9.iterate-dev-stg.workers.dev

prd:
APP_CONFIG={}
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
doppler configs create preview_1 -p <project-slug> -e preview
doppler configs create preview_2 -p <project-slug> -e preview
doppler configs create preview_3 -p <project-slug> -e preview
doppler configs create preview_4 -p <project-slug> -e preview
doppler configs create preview_5 -p <project-slug> -e preview
doppler configs create preview_6 -p <project-slug> -e preview
doppler configs create preview_7 -p <project-slug> -e preview
doppler configs create preview_8 -p <project-slug> -e preview
doppler configs create preview_9 -p <project-slug> -e preview

doppler configs update dev -p <project-slug> --inherits="_shared.dev" --yes
doppler configs update dev_jonas -p <project-slug> --inherits="_shared.dev_jonas" --yes
doppler configs update dev_misha -p <project-slug> --inherits="_shared.dev_misha" --yes
doppler configs update dev_rahul -p <project-slug> --inherits="_shared.dev_rahul" --yes
doppler configs update preview -p <project-slug> --inherits="_shared.preview" --yes
doppler configs update preview_1 -p <project-slug> --inherits="_shared.preview_1" --yes
doppler configs update preview_2 -p <project-slug> --inherits="_shared.preview_2" --yes
doppler configs update preview_3 -p <project-slug> --inherits="_shared.preview_3" --yes
doppler configs update preview_4 -p <project-slug> --inherits="_shared.preview_4" --yes
doppler configs update preview_5 -p <project-slug> --inherits="_shared.preview_5" --yes
doppler configs update preview_6 -p <project-slug> --inherits="_shared.preview_6" --yes
doppler configs update preview_7 -p <project-slug> --inherits="_shared.preview_7" --yes
doppler configs update preview_8 -p <project-slug> --inherits="_shared.preview_8" --yes
doppler configs update preview_9 -p <project-slug> --inherits="_shared.preview_9" --yes
doppler configs update prd -p <project-slug> --inherits="_shared.prd" --yes
```

For preview-enabled new-style apps, use `preview` for the legacy unnumbered slot
and numbered `preview_1` through `preview_9` for repo-managed PR previews. Do
not create `preview_10` or `stg` unless the matching environment config lease
and Cloudflare prerequisites are being added at the same time.

3. Set the tiny app-local secrets:

```bash
doppler secrets set APP_CONFIG="{}" -p <project-slug> -c dev --silent
doppler secrets set APP_CONFIG="{}" -p <project-slug> -c prd --silent
```

That is all. Everything else should come from `_shared`.

4. Turn **Personal Configs** off on the **Development** (`dev`) environment. When this is on, Doppler creates a `dev_personal` branch per user; we do not use that—we use named configs (`dev_jonas`, etc.) instead. This should always be off.

   **Dashboard (needs permission to manage environment settings on the project):** open the project (`doppler open -p <project-slug>` jumps to the dashboard), find the **Development** environment, open the **⋮** menu next to it → **Settings**, turn the **Personal Configs** toggle **off**, **Save**.

   **API (same auth as an interactive `doppler` CLI—uses the credential already on the machine, no manual token paste):**

   ```bash
   curl -sS -X PUT \
     "https://api.doppler.com/v3/environments/environment?project=<project-slug>&environment=dev" \
     -H "Authorization: Bearer $(doppler configure get token --plain)" \
     -H "Content-Type: application/json" \
     -d '{"personal_configs":false}'
   ```

   **Verify:** `doppler configs -p <project-slug>` must not list `dev_personal`. Or `curl -sS "https://api.doppler.com/v3/environments/environment?project=<project-slug>&environment=dev" -H "Authorization: Bearer $(doppler configure get token --plain)"` and check JSON has `"personal_configs":false`.

   **Workplace default (optional, reduces repeat fixes):** **Projects** → **⋮** (top right) → **Default Environments** → for the **dev** row, set **Personal Configs** to off so **new** projects are not created with this enabled. Per [Branch configs / Personal Configs](https://docs.doppler.com/docs/branch-configs).

   There is no `doppler environments …` CLI subcommand for this toggle; use the dashboard or `PUT` above.

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
- For preview-enabled new-style apps, create only `dev`, `dev_jonas`, `dev_misha`, `dev_rahul`, `preview`, `preview_1` through `preview_9`, and `prd` unless the user explicitly asks for more.
- `DOPPLER_CONFIG` is the canonical per-config selector, but it is injected by Doppler itself. Never create it as a secret.
- `ALCHEMY_STAGE` should be set to `${DOPPLER_CONFIG}` in `_shared` so `dev_jonas` resolves to `dev_jonas`, `prd` resolves to `prd`, etc.
- For a new project, the app-local template is just `APP_CONFIG={}` in `dev` and `prd`, plus `APP_CONFIG_BASE_URL` in each leased preview config when the app has a public route.
- Always set `APP_CONFIG` to `{}` in `dev` and `prd`.
- Do not set app-local `ALCHEMY_PASSWORD`, `ALCHEMY_STAGE`, or `ALCHEMY_STATE_TOKEN`. These come from `_shared`.
- Do not add extra app-local secrets unless the app actually needs them.
- If staging comes back later, give `stg` its own distinct password. Do not reuse `dev` or `prd`.
- Personal Configs on the `dev` environment should always be off (dashboard **Development** → **⋮** → **Settings**, or `PUT` to `/v3/environments/environment` with `{"personal_configs":false}` as in step 4).
- Keep `doppler.yaml` in the repo's existing format.

## References

- [Config Inheritance](https://docs.doppler.com/docs/config-inheritance)
- [Branch Configs](https://docs.doppler.com/docs/branch-configs)
- [CLI Reference](https://docs.doppler.com/docs/cli)
- [Monorepo Setup with doppler.yaml](https://docs.doppler.com/docs/environment-based-configuration)
