# iterate

The SDK for Iterate (`apps/os`): context APIs, stream processors, reactive clients, React
bindings, and OAuth app sessions, under `iterate/*`. The package exports source in this
workspace and compiled JavaScript with declarations when packed. The `iterate` command is
[`@iterate-com/cli`](../cli/README.md).

## The SDK/platform line

The SDK holds what user code runs or speaks, and the platform is its first user: apps/os builds
its own entities on `iterate/sdk`, and the first-party apps' code uses only `iterate/*`. Each
subpath in `package.json`'s `exports` is one public module; nothing else is importable.

- A module belongs here when user code runs it or speaks it: a loaded worker, a facet, a
  processor, a browser or Node client, or the wire contract between them and the platform. It
  belongs in apps/os when only the platform's Worker runs it, and in packages/shared when more
  than one app needs it and user code never does.
- Outside apps/os, no package and no app imports apps/os. `import-js/no-restricted-paths` in
  `.oxlintrc.json` resolves each import under `packages/**` and `apps/**` to a file, so type
  imports, re-exports, dynamic `import()` and an app added later are covered, and
  `lint/oxlintrc-platform-line.test.ts` pins it. Tests may import apps/os's two harnesses,
  `apps/os/e2e/support/` and `apps/os/__workers-tests__/support.ts`, which drive a real platform.
- The one known exception: the git codec (`@iterate-com/shared/git-wire`) and the GitHub template
  reader live in packages/shared, though only the platform's Worker runs them. packages/shared is
  private, so they do not cross the line.
- No private core package behind a thin `iterate`: apps/os would then import modules user code
  cannot, and the SDK's types would have to be bundled or published anyway.

Follow-ups: move the git codec and the template reader into `apps/os/src/repo/`, and type the test
harnesses against `iterate/api`. The decision's reasons, and how workerd, the Agents SDK, Convex,
Supabase, tRPC, Hono and Wrangler draw the same line:
[the decision record](https://github.com/iterate/iterate/blob/d52a4e8e0f791c96b683fe178b56570532123c05/docs/2026-09-24-sdk-platform-line.md)
(#3018).

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
