# No raw ITX.get()

`iterate/no-raw-itx-get` refuses a call to `<x>.ITX.get()` and to `.get()` on anything bound from
`<x>.ITX`: a destructured `{ ITX }` (renamed or not), an alias declared, assigned or chained through
another alias, and a class member (`#itx = this.env.ITX`, `this.itx = env.ITX`). It also refuses a
`withItx` callback that answers a live value: the scope itself, a property path of it with no call
(`itx.repos`), or an `itx.cd(path)` handle, awaited or not. `withItx` releases those before its
caller sees them.

It checks linted files and the modules they hand over as text: the value of a `"*.js"` key in a
module map (a string, a template, a `String.raw` template, or a `const` holding one) and a template
marked `/* js */`. An embedded module that mentions `ITX` but does not parse is reported too, so a
module the rule cannot read never passes silently.

`env.ITX.get()` hands out the context's scope. Whatever is kept from it (the scope, an
`itx.cd(path)` step, an awaited answer) keeps the context, and any facet holding it, resident after
the context is evicted. Releasing the scope in a `finally` is not enough: the calls made through it
stay open. `withItx` makes one round trip and then releases the scope, every call made through it,
and every handle it awaited, with the calls made on that handle
([record-pipelined-steps.ts](../../packages/iterate/src/sdk/record-pipelined-steps.ts),
[residency](../../apps/os/docs/residency.md)).

```js
// A config worker, or any other SDK host
const { projectSlug } = await this.withItx((itx) => itx.whoami());

// Anything else: a plain WorkerEntrypoint, a FacetDurableObject, a test fixture
import { withItx } from "./processor.js";
const { projectSlug } = await withItx(this.env.ITX, (itx) => itx.whoami());

// An object that needs reach takes an accessor, never a scope
new Notes((call) => withItx(this.env.ITX, call));
new LiveState({ append: (e) => withItx(this.env.ITX, (itx) => itx.append(e)) }, "chat", {});
```

Work that outlives the call that started it runs under a processor's `runInBackground` claim, and
each reach inside it is still a `withItx` round trip.

An embedded module is reported once per finding, on its literal, naming its lines. A test whose
subject is the careless keep (the context-residency rows) disables the rule above the module's key
with the reason.

Not checked, because lint cannot see them: a module built by string concatenation (the `itx.run`
template in `apps/os/src/library.ts`, pinned by its unit test instead), a module imported from
another file, an entrypoint stashed and restored from storage, and a callback answer that is a
handle only its type reveals (`itx.repos.get(path)` answers a handle, `itx.whoami()` data).
