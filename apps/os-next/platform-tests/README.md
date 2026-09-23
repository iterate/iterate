# First-party facet RPC reproduction

This manual test uses a dedicated Cloudflare Worker containing no OS data or credentials. It is excluded from the normal unit/workers tests. A missing URL fails explicitly.

Copy `native-rpc-facet-reuse.wrangler.jsonc`, set a dedicated worker name/account, and deploy from `apps/os-next` using its pinned Wrangler (`pnpm exec wrangler deploy --config <copy>`). Keep the fixture path valid. The declarative SQLite exports and compatibility flags match OS-Next. Do not deploy this fixture over an application Worker.

From the repository root:

```sh
NATIVE_RPC_PIN_URL=https://<dedicated-worker>.workers.dev \
  pnpm --dir apps/os-next exec vitest run --config platform-tests/vitest.config.ts
```

Each of ten fresh parent objects obtains the same named `ctx.exports.Repo({ props })` facet on four separate requests: two sequential, then two concurrent. Every response must succeed and carry the expected build marker. No retries or recovery hide a failed native call. The fixture preserves native error references in its JSON response.

## Evidence and limits (2026-09-23)

The original production trace failed before `RepoDurableObject.modules()` entered, with `internal error; reference = gk8cs8g1t4jr3os30l1jdsgb` (trace `7b8b77a5857e9b62a499ff3883ac7522`). Earlier minimal runs reproduced failures on repeated first-party facet RPC in the production account, while the Worker Loader control and preview account passed.

The fault is intermittent. Later unchanged controls passed. A corrected, interleaved matrix using Wrangler 4.131.1, matching compatibility flags, two Worker names per account and six transport/class variants passed all 720 requests. Twelve concurrent read-only Lispwoso RPC checks passed in the same window. The earlier minimal deployment used an older Wrangler that ignored its `exports` field; this fixture fixes that mismatch.

This is an ordinary contract test, **not a holding `createFailing` pin or a verified fix**. A green run cannot establish that a candidate workaround fixed an intermittent platform fault. Compare candidates against an interleaved failing control before changing the platform. Current evidence does not distinguish account-specific behavior from Worker placement or timing, and does not establish that preview status itself matters.

The in-process regression in `__workers-tests__/facet-from-exports.test.ts` exercises actual project/repo facets and requires zero recovery restarts; successful replies alone can hide the native fault behind the existing retry.
