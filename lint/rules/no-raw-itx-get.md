# No raw ITX.get()

`iterate/no-raw-itx-get` refuses a zero-argument `.get()` on `ITX` or on an `<x>.ITX` member
(`this.env.ITX.get()`, `env?.ITX?.get()`, `env["ITX"].get()`, a destructured `ITX.get()`), in
linted files and in the modules they hand over as text: the value of a `"*.js"` key in a module map
(a string, a template, a `String.raw` template, or a `const` holding one) and a template marked
`/* js */`. In a linted file it also refuses a `getItx()` call that no `using` declaration binds,
unless an arrow answers it whole (an accessor, `() => this.getItx()`).

`env.ITX.get()` hands out the context's scope. Whatever is kept from it (the scope, an
`itx.cd(path)` step, an awaited answer) keeps the context, and any facet holding it, resident after
the context is evicted. Releasing the scope in a `finally` is not enough: the calls made through it
stay open. `getItx()` hands out the same scope, recorded: disposing it releases the scope, every
call made through it, and every handle it awaited, with the calls made on that handle
([itx-scope.ts](../../packages/iterate/src/sdk/itx-scope.ts),
[residency](../../core/os/docs/residency.md)). `using` disposes it when the block ends;
`const itx = this.getItx()` never does.

```js
// Every loaded WorkerEntrypoint, and every SDK host: IterateConfigEntrypoint, FacetDurableObject,
// StreamProcessorDurableObject
using itx = this.getItx();
const { projectSlug } = await itx.whoami();

// An object that needs reach takes an accessor, never a scope
new Notes(() => this.getItx());
new LiveState(
  {
    append: async (e) => {
      using itx = this.getItx();
      await itx.append(e);
    },
  },
  "chat",
  {},
);
```

Put the `using` in the smallest block that holds its calls, await every call before the block ends
(`return await itx.whoami()`), and hand data, not handles, out of it. Work that outlives the call
that started it runs under a processor's `runInBackground` claim, and each reach inside it is still
its own `using` block.

An embedded module is reported once, on its literal, naming its lines. A test whose subject is the
careless keep (the context-residency rows) disables the rule above the module's key with the reason.

Not checked: an alias of the binding (`const binding = env.ITX`, `#itx = this.env.ITX`; no
first-party code keeps one), a `getItx()` inside an embedded module, a module built by string
concatenation (the `itx.run` template in `core/os/src/library.ts`, pinned by its unit test instead)
or imported from another file, an entrypoint stashed and restored from storage, a call a block
returns unawaited, and a handle a block hands out.
