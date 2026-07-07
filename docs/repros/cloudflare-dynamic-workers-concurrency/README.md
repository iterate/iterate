# Cloudflare Dynamic Workers concurrency repro

Minimal repro for the undocumented `Too many concurrent dynamic workers` behavior.

This directory is intentionally standalone. It does not import product code and does not require changes to the repo root config.

## Observed behavior

The deployed Worker exposes endpoints that use a Worker Loader binding directly:

- `/distinct?count=24` concurrently calls `env.LOADER.load(...)` with 24 different source strings, then invokes each Dynamic Worker's default `fetch` entrypoint.
- `/same-source-get?count=24` is the control path: it loads one cached Dynamic Worker via `env.LOADER.get(...)` and invokes that same source 24 times concurrently.
- `/same-source-load?count=24` is an extra control: it calls `env.LOADER.load(...)` 24 times with identical source bytes.

In affected deployments, `/distinct` returns a mix of successes and errors. The errors include:

```text
Too many concurrent dynamic workers
```

The same-source cached control is expected to return 24 successes.

## Expected behavior

Cloudflare's Dynamic Workers docs describe `load()` as creating a fresh Dynamic Worker for one-time execution and `get(id, callback)` as reusing a cached Dynamic Worker. The docs also say Dynamic Workers can spin up an unlimited number of Workers on demand, while normal Workers limits are documented separately.

Expected platform behavior is one of:

- all 24 direct, depth-1 Dynamic Worker loads succeed, or
- Cloudflare documents a per-invocation/per-isolate concurrency limit for distinct Dynamic Worker sources and provides deterministic throttling guidance.

## Deploy

From this directory:

```bash
npx wrangler@latest deploy worker.ts --name cloudflare-dynamic-workers-concurrency-repro
```

Assumption: current Wrangler accepts a Worker Loader binding in config as:

```jsonc
{
  "main": "worker.ts",
  "compatibility_date": "2026-07-07",
  "worker_loaders": [{ "binding": "LOADER" }],
}
```

If the CLI form above cannot attach the binding directly, create a temporary `wrangler.jsonc` with that snippet next to `worker.ts` and deploy with `npx wrangler@latest deploy --config wrangler.jsonc`.

Use the deployed `workers.dev` URL from Wrangler output as `BASE_URL`.

## Run

```bash
BASE_URL=https://cloudflare-dynamic-workers-concurrency-repro.<subdomain>.workers.dev bash run.sh
```

or:

```bash
bash run.sh https://cloudflare-dynamic-workers-concurrency-repro.<subdomain>.workers.dev
```

The script prints pass/fail lines for:

- same-source cached control success
- distinct-source repro observation

You can adjust the fan-out while staying below 32 total Worker invocations:

```bash
COUNT=16 bash run.sh https://cloudflare-dynamic-workers-concurrency-repro.<subdomain>.workers.dev
COUNT=24 bash run.sh https://cloudflare-dynamic-workers-concurrency-repro.<subdomain>.workers.dev
```

Direct endpoint checks:

```bash
curl -sS "$BASE_URL/same-source-get?count=24"
curl -sS "$BASE_URL/distinct?count=24"
curl -sS "$BASE_URL/same-source-load?count=24"
```

## Why this is not the documented Worker invocation chain limit

This repro is a single parent Worker request doing parallel, depth-1 Dynamic Worker invocations. The Dynamic Worker code does not call another Worker, does not use service bindings, and has `globalOutbound: null`.

With the default `count=24`, the shape is at most one parent Worker plus 24 direct Dynamic Worker invocations. That is below a 32 Worker-run chain threshold, and it is not a chain: there is no nested Worker-to-Worker recursion. The same-source control performs comparable fan-out from the same parent request and is expected to succeed, which points at concurrent distinct Dynamic Worker source loading rather than generic Worker invocation depth.

Relevant Cloudflare docs:

- Dynamic Workers getting started: https://developers.cloudflare.com/dynamic-workers/getting-started/
- Workers limits: https://developers.cloudflare.com/workers/platform/limits/
