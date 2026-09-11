# Build RPC lifetime — 5 September 2026

The public build contract returns inert, structured data; it contains no live
capabilities. The original six calls in `e2e/build.test.ts` each recorded a
canceled native `Context.build` invocation after the caller received and
checked its result. A matching nested-RPC control identified the missing
pipeline disposal; the final deployed fix below records six `ok` invocations.
This was not an expected source diagnostic or evidence that bundling failed.

```ts
const result = await context.build.build({
  source: { repo: "site", revision },
  options: { entryPoint: "src/main.ts" },
});
// Three successful calls: miss, hit, changed-option miss.
// Three source rejections: syntax, missing import, registry dependency.
```

Account `04b3b57291ef2626c6a8daa9d47065a7`, service
`iterate-project-core-domain-poc`. All comparisons retain the same bundler
version `a3ac60c1-7243-474a-b61f-c2a0bf1a8da7` and the public test code.

| Core version                           | One changed boundary                              | Query window UTC  | Context build outcomes |
| -------------------------------------- | ------------------------------------------------- | ----------------- | ---------------------- |
| `a5f2d85e-e134-4a19-8a90-8bdf628e4edd` | Original forwarding                               | 13:18:03–13:18:30 | 6 canceled             |
| `416c0126-3284-44ae-8a16-f88e26335256` | `async Context.build()` awaits the bundler        | 13:22:23–13:22:38 | 6 canceled             |
| `018fe962-07c5-491f-9afb-3f1509cc913b` | Original Context; Scope's callback awaits Context | 13:27:38–13:28:13 | 6 canceled             |

The second control changes:

```ts
async build(value: BuildInput) {
  const input = BuildInput.parse(value);
  return await this.env.BUNDLER.build({
    files: this.repos.read(input.source.repo, input.source.revision).files,
    options: input.options,
  });
}
```

The third restores that method and instead changes the Cap'n Web-facing facet:

```ts
override get build() {
  return new Builder(async input => await this.#host.build(input));
}
```

Neither control fixes or classifies the observation. The focused second
control passes both public tests in 6,529.911583 ms; its exact window has no
warning/error logs. Example rejected-build trace:
[`103f46bac85da81f1b675a7746838b32`](https://dash.cloudflare.com/04b3b57291ef2626c6a8daa9d47065a7/observability/traces/103f46bac85da81f1b675a7746838b32).
The third control passes the full 44-test suite in 74,904.597833 ms;
its rejected-build trace is
[`2109913a403451e314f48ddbf2324757`](https://dash.cloudflare.com/04b3b57291ef2626c6a8daa9d47065a7/observability/traces/2109913a403451e314f48ddbf2324757).

## Repeat the observation

```sh
WORKER_BASE_URL=https://iterate2.com node --test e2e/build.test.ts
```

Record the UTC interval, then query `cloudflare-workers` for the exact service
and window. Inspect top-level `$workers.event.rpcMethods` containing `build`,
`$workers.outcome`, and `$workers.scriptVersion.id`; include separate error/warn
queries. The general query shape is in [fetch-lifetime.md](fetch-lifetime.md).
Do not infer native success from the two green test assertions.

Explicit disposal is not a generic solution: workerd's `RpcPromise.dispose()`
also disposes its resolved result, which could revoke a returned capability.
Only a controlled pure-data case can justify that here.

## Matching nested RPC and the retained fix

The isolated probe reproduces the load-bearing second native hop:

```text
Cap'n Web Scope.build getter -> Builder RpcTarget
  -> Context.build -> BuildService.build -> plain JSON
```

On probe version `ff7855ef`, fifteen constant-result calls finish `ok`.
With the second native service, direct forwarding and an awaited wrapper each
produce five canceled Context invocations; explicitly disposing the settled
Context RPC promise produces five `ok` invocations. All fifteen service calls
finish `ok`, and all thirty public calls return the same fully consumed data.
The equivalent native-child control repeats twenty calls per arm with the
same result. The matrices, exact versions and query are retained in
[the probe README](../../project-core-ws-probe/README.md).

Holding and disposing the public Builder facet is not the same operation:
[`e2e/build-lifetime.ts`](../e2e/build-lifetime.ts) tried a direct build and two
calls on `using builder = await context.build`. All three Context invocations
still canceled on `018fe962`; all bundler calls were `ok` (trace
[`e64f5180032f0f9c9f03342e9d471b08`](https://dash.cloudflare.com/04b3b57291ef2626c6a8daa9d47065a7/observability/traces/e64f5180032f0f9c9f03342e9d471b08)).

The retained change belongs specifically in `Scope`'s build adapter:

```ts
return new Builder(async (input) => {
  using result = this.#host.build(input);
  return await result;
});
```

`BuildResult` is constrained to inert code and diagnostics. This does not
dispose arbitrary capability-bearing results or alter the public contract.
There is no retry, swallowed rejection, telemetry filter or compatibility
fallback. Disposal also runs if awaiting the result rejects.

Core version **`f0032a5a-cc05-4ee7-8016-c40452062dfb`** passes **44/44** public
tests at **13:40:52.220–13:41:30.705 UTC**, 38,183.850083 ms; local 44/44 takes
34,341.280084 ms. No tests fail, cancel or skip. The final exact-window audit
records all six Context builds **`ok`**, with zero canceled builds, alongside
six `ok` bundler builds. Rejected-build trace:
[`930971d621e83d04673c2efb9a083ba9`](https://dash.cloudflare.com/04b3b57291ef2626c6a8daa9d47065a7/observability/traces/930971d621e83d04673c2efb9a083ba9).
The full suite's intentional error/closure outcomes are separately classified
in [domain-preview.md](domain-preview.md).
