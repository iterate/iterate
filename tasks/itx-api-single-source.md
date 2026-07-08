---
status: in-progress
size: large
supersedes: https://github.com/iterate/iterate/pull/1655
---

# itx API as one thing — base-class opt-in + native TS SDK

## Status summary

Fresh remake of PR #1655 ("Spike: itx types as one thing — generate the contract
from RpcTargets + zod") off current main, incorporating Misha's two concrete
review suggestions. Not started yet beyond this spec; the port of #1655 lands as
the next commit, then the two changes on top.

## Context

PR #1655 makes the RpcTarget classes (docstrings + explicit signatures) and the
zod schemas the single source of truth for the public itx API, deletes the
hand-written `types.ts`, and generates `src/itx-api.generated.ts` — a
standalone, import-free, annotated file that itx scripts typecheck against,
humans read as reference, and agents/the REPL receive verbatim. That PR is
CI-green but conflicting with main. Misha reviewed it and asked for it to be
remade fresh off main with his concrete suggestions applied ("remake the PR as
is but doing my suggestions"). The `__describe()`/JSDoc overlap question from
review is explicitly *out of scope* — he's mulling that one.

## The two suggestions (from PR #1655 review comments)

### 1. `IterateRpcTarget<Name>` base class as the codegen opt-in

Instead of the generator regex-matching `*RpcTarget` class names, stripping the
suffix, and keeping a `RELAY_CONTRACTS` override table, introduce a trivial
base class that is both the opt-in-to-codegen signal and the
name-of-the-published-interface carrier:

```ts
class IterateRpcTarget<Name extends string> extends RpcTarget {}

class ProjectEgressRpcTarget extends IterateRpcTarget<"ProjectEgress"> {
  /** Outbound fetch with the project's identity and secret substitution. */
  fetch(request: Request): Promise<Response> { /* ... */ }
}
```

Benefits (Misha's words, paraphrased):

- no reliance on naming conventions / regex-matching classnames
- the class → interface mapping is hinted at properly (JSDoc on the base class)
- can later become abstract to force `__describe()` etc. (NOT in this task)
- enables a simpler type-test: deterministically `.replace` each
  `class X extends IterateRpcTarget<"Name"> {` with the same text plus
  `implements Name`, and assert the result typechecks against the generated
  interfaces — restoring the "impl satisfies contract" safety net that #1655
  gave up when it dropped `implements Stream` from the classes.

Design decisions made on Misha's behalf (flag if wrong):

- The type argument REPLACES both the suffix-stripping rule and the
  `RELAY_CONTRACTS` table: a class whose `Name` resolves to an exported named
  type (e.g. `IterateRpcTarget<"StreamProcessorRpc">`) is a relay onto that
  contract; otherwise the generator emits an interface named `Name` from the
  class's members.
- Class names keep their `RpcTarget` suffix (Misha's example does).
- Subclass chains (`AgentRpcTarget extends ProjectRpcTarget` style extension)
  each name their own interface via their own `IterateRpcTarget<…>`? No —
  a subclass extends its parent class directly; it opts in by its heritage
  chain reaching `IterateRpcTarget`, and carries its own name via the parent's
  generic where needed. Concrete shape decided during implementation; the
  invariant is: every published interface name is spelled once, as a string
  literal, in the class declaration that defines it.
- `IterateRpcTarget` lives in `rpc-targets.ts` (single consumer file today).

### 2. TypeScript native SDK instead of the stock `typescript` package

The #1655 generator builds a `ts.createProgram` over the monorepo (~3s) using
the `typescript` npm package. Port it to `@typescript/native-preview`
(`unstable/sync` API) — already a repo dependency, already used by the
type-aware lint plugin (`lint/oxlint-type-aware.ts`), faster, and the thing
we'll standardize on. Same for the standalone-typecheck guard test if
practical (a temp-dir + `getSemanticDiagnostics` pass is acceptable there).

## Checklist

- [ ] Port PR #1655 onto current main (squash-merge `victorious-wish`, resolve
      conflicts, regenerate generated artifacts, all checks green)
- [ ] Introduce `IterateRpcTarget<Name extends string>` in `rpc-targets.ts`;
      migrate every RpcTarget class to it (including relay classes, whose
      `Name` is the contract they front)
- [ ] Rewrite `scripts/generate-itx-api.ts` discovery: heritage-chain check +
      `Name` type argument; delete `RELAY_CONTRACTS` and the suffix regex
- [ ] Port the generator to `@typescript/native-preview/unstable/sync`
- [ ] Add the `implements`-injection type test (deterministic `.replace`, then
      typecheck) alongside the freshness + standalone tests
- [ ] Regenerate `itx-api.generated.ts`, `types-source.generated.ts`, and the
      project-repo-template `sdk.ts` copy
- [ ] `pnpm typecheck && pnpm lint && pnpm format && pnpm test` green; PR open
      as draft with monitors running

## Implementation log

(append as work happens)
