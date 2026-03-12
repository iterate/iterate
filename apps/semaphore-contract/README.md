# semaphore-contract

Shared oRPC contract and client factory for `apps/semaphore`.

Use `createSemaphoreClient({ apiKey, baseUrl })` for normal HTTP access, or pass `fetch` instead of `baseUrl` when you want a custom transport such as a Cloudflare service binding in the future.
