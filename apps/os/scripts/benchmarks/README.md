# Live streaming benchmarks

Run the transport benchmark from the repository root:

```sh
pnpm --dir apps/os exec tsx scripts/benchmarks/live-state.ts
```

For browser rendering, start the OS dev server to supply the generated app
CSS. Build the actual component with React's production profiling renderer:

```sh
bench_dir=$(mktemp -d)
pnpm --dir packages/iterate exec esbuild \
  ../../apps/os/scripts/benchmarks/live-streaming-render.tsx \
  --bundle --format=esm --platform=browser \
  --tsconfig=../../apps/os/tsconfig.json \
  --define:process.env.NODE_ENV='"production"' \
  --define:import.meta.env='{"SSR":false,"DEV":false,"PROD":true}' \
  --alias:react-dom/client=react-dom/profiling \
  --loader:.woff=file --loader:.woff2=file --loader:.ttf=file \
  --minify --outfile="$bench_dir/benchmark.js"
```

Save the dev server's `/src/styles.css?direct` response to
`$bench_dir/styles.css`. In that directory, create an `index.html` containing:

```html
<!doctype html>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="stylesheet" href="/styles.css" />
<link rel="stylesheet" href="/benchmark.css" />
<script type="module">
  import { benchmark } from "/benchmark.js";
  window.benchmark = benchmark;
</script>
```

Serve only that directory on localhost, open it in an isolated Playwriter
headless session, and call `window.benchmark(options)` in the page. Options:
`size`, `chunkSize`, `kind: "prose" | "code"`, `collapsed`, `codePane`, and
`keepMounted` (for visual inspection). Defaults are 64 KiB, 1 KiB, prose,
expanded. The synthetic fixture is deliberately deterministic; no model call,
network latency, or production data is involved.

Use a 1280 × 900 viewport for desktop. For mobile, set 390 × 844 and send
`Emulation.setCPUThrottlingRate({ rate: 4 })` through the session's CDP client.
Reset it to 1 afterwards. Allow each run to finish before starting the next;
each run unmounts its predecessor and replaces the benchmark page body.

The JSON in `results/` records the 10 September 2026 measurements.
`render-baseline.json` used the pre-change renderer; the 1 MiB baseline
deliberately exceeds its old server preview cap. The final renderer displays
about 32K characters while retaining the full input for its snapshot viewer.
See [the decision and limitations](../../docs/streaming-performance.md).
