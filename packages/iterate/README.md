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
