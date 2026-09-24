# Doppler setup for a new app

`envs.ts` owns every non-secret value: worker names, URLs, accounts and the PostHog key. An app
on the platform has no secrets of its own. Its Doppler project exists only to hand the deploy
the Cloudflare credentials and the CI Slack token, which it inherits from `_shared`.

- Create project `<app>`, the same name as the directory and `StartApp.name`. `deployApp` reads
  it (`scripts/lib/start-app.ts`).
- Create config `prd` inheriting `_shared/prd`. The prd deploy and its Slack notice need nothing
  more. Add `preview` inheriting `_shared/preview` only if you will deploy the parent
  `<app>-preview` Worker by hand. Per-PR previews run under `os/preview` and never
  read the app's project.
- Do not copy older apps' `dev_<person>` or `preview_<n>` configs. They are leftovers of the
  leased-preview era.
- Add `project: <app>` with `path: apps/<app>/` to `doppler.yaml`, without pinning a config.
- Confirm by name only, never by value:
  `doppler secrets --project <app> --config prd --only-names` should list
  `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`.

```sh
doppler projects create <app>
doppler configs create prd --project <app> --environment prd
doppler configs update --project <app> --config prd --inherits=_shared.prd
```

The `_shared` configs are already inheritable. Check `doppler configs update --help` if the
flags have changed.
