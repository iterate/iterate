# AI engineer workshop

Hands-on exercises live under per-participant folders (for example `jonas/`). Each folder is its own pnpm package so dependencies stay isolated and you can copy the folder for a new participant without touching the rest of the repo.

## Layout

- `jonas/` — example participant package (`package.json`, scripts, notes)
- `jonas/web/` — optional space for a small web UI or static assets during the session
- `jonas/01-hello-world.*` — first exercise: append a demo event to the Iterate events API (same idea as `apps/events/scripts/demo/router.ts` `hello-world` command)

## Run the hello-world script

From the repo root (after `pnpm install`):

```bash
cd ai-engineer-workshop/jonas
pnpm tsx 01-hello-world.ts
```

Edit the constants at the top of `01-hello-world.ts` to change the target stream or environment.

## Adding another participant

Copy `jonas/` to a new folder (for example `alex/`), rename the `name` field in `package.json`, and add any personal notes alongside the same file names.
