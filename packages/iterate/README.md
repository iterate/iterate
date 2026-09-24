# iterate

The SDK for Iterate (`apps/os`): context APIs, stream processors, reactive clients, React
bindings, and OAuth app sessions, under `iterate/*`. The package exports source in this
workspace and compiled JavaScript with declarations when packed. The `iterate` command is
[`@iterate-com/cli`](../cli/README.md).

The SDK holds what user code runs or speaks, and the platform is its first user: apps/os builds
its own entities on `iterate/sdk`, and the first-party apps' code uses only `iterate/*` (lint
refuses any import of apps/os from another app or package, apps/os's test harnesses aside). Code
that only the platform's Worker runs stays in apps/os.
Each subpath in `package.json`'s `exports` is one public module; nothing else is importable. The
rule and its reasons: [the SDK/platform line](../../docs/2026-09-24-sdk-platform-line.md).

## Reaching the context from loaded code

Code the platform loads for a project (a config worker, a facet, a worker behind a rewrite rule)
imports the SDK as `./processor.js` and reaches its context through `withItx`: one round trip,
after which the scope, every call made through it and every handle it awaited are released.

```js
import { ConfigWorker, withItx } from "./processor.js";

export default class extends ConfigWorker {
  async fetch() {
    // An SDK host (ConfigWorker, StreamProcessorDurableObject) has it as a method.
    const { projectSlug } = await this.withItx((itx) => itx.whoami());
    return new Response(`Homepage of ${projectSlug}`);
  }
}

// Anywhere else: withItx(this.env.ITX, (itx) => itx.kv.get("key"))
```

Never keep what `env.ITX.get()` hands out, and answer data, not handles, from `withItx`: a kept
scope, step or handle keeps the context, and any facet holding it, resident after the project goes
idle. An object that needs
reach takes a `WithItx` accessor (`(call) => withItx(this.env.ITX, call)`), never a scope; work
that outlives the call runs under a processor's `runInBackground` claim. Lint refuses a raw
`ITX.get()` in this repository (`iterate/no-raw-itx-get`).

## Testing a processor

`iterate/stream/test-support` (Node) is the harness the SDK's own engine tests use:

```ts
import { reduceProcessor } from "iterate/stream/test-support";

// apps/os/src/client/presence/processor.test.ts: durable ticks are reduced, ephemeral pokes are not
const state = reduceProcessor(new PresenceProcessor(), [{ type: "tick" }, { type: "poke" }]);
// state.ticks === 1
```

`memoryStream`, `memoryStorage` and `settle` drive a whole `ProcessorEngine` against an
in-memory log (`src/stream/processor.test.ts` shows how).

## Node connections

`iterate/node` exposes a connection owner for Iterate scripts and live
providers. It uses the same protocol and cleanup as the CLI:

```js
import { connectIterate } from "iterate/node";

using connection = await connectIterate({
  baseUrl: "https://os.iterate.com",
  auth: { type: "bearer", token: process.env.ITERATE_BEARER_TOKEN },
});
using project = await connection.session.projects.get("my-project");
console.log(await project.run("async (itx) => await itx.whoami()"));
```
