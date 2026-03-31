# 01 — Hello world (events append)

This exercise mirrors the **hello-world** handler in `apps/events/scripts/demo/router.ts`: it builds an oRPC client against the public events worker and calls `append` with a single demo event.

## What to do

1. Open `01-hello-world.ts` and read the constants at the top (`BASE_URL`, `STREAM_PATH`, event type).
2. Run from this package:

   ```bash
   pnpm tsx 01-hello-world.ts
   ```

3. You should see JSON printed — the API response from appending the event.

## Optional

- Point `BASE_URL` at another deployed stage if you have one.
- Change `STREAM_PATH` to a path under `/` (leading slash is normalized the same way as the demo router).
