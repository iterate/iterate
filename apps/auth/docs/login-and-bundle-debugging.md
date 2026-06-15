# Login And Bundle Debugging Notes

Date: 2026-06-12

## What I observed

- `apps/os` dev sign-in can look like a no-op if the user clicks the SSR-rendered button before the client has hydrated.
- In a Playwright repro against `http://localhost:61975/sign-in?redirect_url=%2F`, an immediate click produced no `/api/iterate-auth/login` request. Waiting longer before clicking produced the expected request:
  `GET /api/iterate-auth/login?return_to=%2F`.
- The slow hydration is made worse because the OS dev client loads `src/start.ts`, then `src/auth/middleware.ts`, then `apps/auth/src/lib/server.ts`. That pulls server auth code into the dev client graph before the sign-in button handler is active.
- The auth worker build also has a large startup surface. A synthetic esbuild bundle of `apps/auth/src/server/worker.ts` was about `3.75 MB` unminified without code splitting.

## Likely login fixes

1. Make the OS sign-in control a real link to `/api/iterate-auth/login?return_to=...` instead of a JS-only button.
   This makes the browser navigate even before React hydration finishes.

2. Keep OS request middleware server-heavy imports behind a server boundary.
   The direct `apps/os/src/start.ts -> apps/os/src/auth/middleware.ts -> @iterate-com/auth/server` chain is a dev hydration cost and makes early clicks unreliable.

3. Keep the random OS dev port stable across clean restarts.
   OAuth redirect URLs include the random port, so changing ports makes local auth harder to reason about and can leave browser state/bookmarks pointing at the wrong callback URL.

## Auth Bundle Findings

Synthetic bundle command used:

```bash
pnpm --dir apps/os exec esbuild ../../apps/auth/src/server/worker.ts \
  --bundle --splitting --format=esm --platform=browser --target=es2022 \
  --define:process.env.NODE_ENV='"production"' \
  '--external:cloudflare:workers' '--external:node:*' \
  '--external:__STATIC_CONTENT_MANIFEST' \
  '--external:#tanstack-router-entry' '--external:#tanstack-start-entry' \
  '--external:tanstack-start-manifest:v' \
  '--external:tanstack-start-injected-head-scripts:v' \
  --metafile=/tmp/auth-worker-prod-split-meta.json \
  --outdir=/tmp/auth-worker-prod-split
```

Top source contributors from the metafile:

- `better-auth`: about `914 KB`
- `kysely`: about `635 KB`
- `zod`: about `537 KB`
- `react-dom`: about `515 KB` in production-mode input bytes
- `@opentelemetry/semantic-conventions`: about `280 KB`
- `@tanstack/router-core`: about `194 KB`
- `@better-auth/oauth-provider`: about `156 KB`
- `sqlfu`: about `146 KB`

## Likely Auth Optimizations

1. Lazy-load `@tanstack/react-start/server-entry` inside the fallback `app.all("*")` route in `apps/auth/src/server/worker.ts`.
   API requests under `/api/auth/*`, `/api/orpc/*`, discovery routes, and `/logout` do not need React SSR at startup.

2. Replace the Better Auth plugin barrel import in `apps/auth/src/server/auth-plugins.ts`.
   Current import:

```ts
import { bearer, deviceAuthorization, emailOTP, jwt, oneTimeToken } from "better-auth/plugins";
```

Direct imports are available and should avoid pulling unused plugin modules such as `open-api` and `mcp`:

```ts
import { bearer } from "better-auth/plugins/bearer";
import { deviceAuthorization } from "better-auth/plugins/device-authorization";
import { emailOTP } from "better-auth/plugins/email-otp";
import { jwt } from "better-auth/plugins/jwt";
import { oneTimeToken } from "better-auth/plugins/one-time-token";
```

3. Investigate why `@opentelemetry/semantic-conventions` is in the auth worker bundle.
   The likely path is through oRPC plugins or shared server dependencies. If auth does not need telemetry metadata on the login path, isolate that import behind the oRPC route or a lazy module.

4. Consider splitting the auth API worker from the React UI worker if cold starts remain slow.
   The current worker statically combines Better Auth, oRPC, DB/query helpers, and TanStack Start SSR.

## Verification Already Run

- `pnpm --dir apps/auth typecheck`
- `pnpm --dir apps/os typecheck`
- Playwright repro confirming immediate pre-hydration click did not request login, while a later click did.
- Temporary local-dev-server check confirmed preserving `.alchemy/dev-server.json` would allow reuse of the same random port when still free.
