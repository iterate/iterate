# cloudflare-os conventions — findings + adoption guide

Findings from analyzing `iterate/cloudflare-os` (local checkout `~/src/github.com/iterate/cloudflare-os`,
analyzed 2026-08-07 at `aedcda8` and 2026-08-19), and instructions for adopting what's worth adopting
into the clean room (`packages/v3/*`). The package layout itself was already adopted as **D40** (ledger:
`apps/os/docs/simplification/wayfinder/innermost-core/map.md`); this doc records the rest — TS config,
wrangler config, dev orchestration, source layout, and testing — with per-item verdicts.

**The through-line.** Everything cloudflare-os does well is one instinct applied repeatedly: _configs are
data with one source of truth; discovery is by convention, never by registry; every mechanism is a small
plain-Node script, not a framework; every package is a leaf with no build graph._ And everything it does
badly is one failure repeated: _uniformity maintained by hand-copying with no checker_ (drifting committed
`worker-configuration.d.ts` files, inconsistent tsconfig `paths`, a missing `observability` block). Adopt
the instinct; add the cheap conformance check they skipped whenever we repeat a block.

---

## 1. Package layout (ADOPTED — D40)

Their rules, now ours:

- **No `apps/` vs `packages/` split.** One flat directory of packages; **a package is a deployable worker
  iff it has a `wrangler.jsonc`**, else it's a pure library. Their dev orchestrator, release-manifest
  builder, and test harness all _discover_ workers this way — no central registry file.
- **Granularity is per deployed worker, never per class.** `gatekeeper-slack` is one package holding 13
  classes (default fetch + `WorkerEntrypoint`s + 4 DOs) in one file. Don't split a worker's internals
  into packages.
- **Shared libraries are consumed as raw `.ts` source** via package `exports` maps
  (`"./egress": "./src/egress.ts"`) — no dist builds. Their one dist-built package (`typed-storage`) is
  their one build-order landmine, special-cased in every launcher.
- **Contract packages sit at the bottom** with zero workspace deps (`workshop-shared`), held to a higher
  review bar (doc-comment every export; never hand-mirror an RPC interface).
- **Admission bar for shared code** (from `mcp-shared`'s README): code moves to a shared package only when
  two copies would eventually disagree _and the disagreement would be a bug_. Otherwise duplication is
  fine. (`@v3/shared` follows this: it holds only `./egress` today; the dial contract lived there briefly
  and left when the runner path was deleted in cook-1.)

Current state: `packages/v3/{project-worker, control-plane-shell, control-plane}` (workers) +
`packages/v3/shared` (pure lib). Worker names on Cloudflare never changed across the restructure —
renaming a worker is a data migration for its DOs (the cross-script `CONTEXT` binding pins
`script_name: "project-worker"`).

---

## 2. TS config

**What they do:** a settings-only root `tsconfig.json` (`include: []`, `noEmit: true` — pure inheritance,
never a project); every package extends it and is independently checkable with `tsc --noEmit`. **No
project references, no composite, no build graph** — TypeScript is only ever a checker; wrangler/vite
bundle from source. Env typing comes from `types: ["./worker-configuration.d.ts"]` per worker.

**Their mistakes:** (a) cross-package imports resolve through _two_ hand-maintained schemes at once —
tsconfig `paths` into sibling `src/` _and_ exports maps → `.ts` — inconsistently listed per package, and
it cost them type-aware linting; (b) vestigial `outDir`/`declaration`/`noEmit: false` in packages nothing
consumes as dist; (c) the committed `worker-configuration.d.ts` files: 18 × ~14.7k lines, no regen
script, observable workerd-version drift between them.

**Adoption:**

- Already right in v3: exports-maps-only resolution (no `paths`, ever), standalone per-package tsconfigs,
  `tsc --noEmit` as the only TS invocation, and stricter options than theirs (`verbatimModuleSyntax`,
  explicit `.ts` import extensions).
- The four v3 tsconfigs are currently identical copies. When they next need a change, hoist a
  `packages/v3/tsconfig.base.json` (settings-only, `include: []`) and make each package
  `"extends": "../tsconfig.base.json"` — their root-base pattern, scoped to v3. Do not do this
  preemptively; do it on the first divergence-risk edit.
- Never add project references or a dist build for a shared package. If a consumer seems to need built
  output, the consumer is wrong.
- Env types: keep hand-written `interface Env` per worker (small, reviewed). If we ever want typed
  `ctx.exports`, generate `worker-configuration.d.ts` in CI — never commit it by hand.

---

## 3. Wrangler configs

**What they do:** the checked-in `wrangler.jsonc` is the single source of truth per worker, treated as
_data_. Three independent consumers (dev orchestrator `run-dev-server.js`, release manifest
`scripts/release/manifest-lib.mjs`, test harness `integration-tests/src/harness.ts`) each parse the jsonc
and patch a **gitignored copy** — nothing about a worker is written down twice. The release side **fails
closed on any wrangler key it doesn't recognize** (`HANDLED_CONFIG_KEYS` + a golden-file test), so a new
binding type can't silently half-ship. Codegen runs via `build: { command, watch_dir }` inside the
wrangler config, so `wrangler dev`/`deploy` are always complete commands. DOs are reached via
`ctx.exports.ClassName` — configs declare only `migrations`, so bindings can't drift from classes. Every
config carries `"$schema"` pointing at wrangler's schema.

**Adoption:**

1. **Add `"$schema": "../../../node_modules/wrangler/config-schema.json"`** to the three v3 wrangler
   configs. Free editor validation, zero cost.
2. **Move the SDK codegen into wrangler's build hook.** Today `project-worker` chains it by hand in every
   script (`"dev": "node build-sdk.mjs && wrangler dev"`, same for `deploy` and `test`). Their pattern is
   better: `"build": { "command": "node build-sdk.mjs", "watch_dir": "src" }` in `wrangler.jsonc`, then
   the scripts collapse back to plain `wrangler dev` / `wrangler deploy` and _any_ consumer of the config
   (a future dev orchestrator, `createTestHarness`) gets the codegen for free instead of needing to know
   the incantation. Keep the generated file committed (it already is, so typecheck works without a
   build) — that part is our call, not theirs, and it's fine.
3. **Consider `ctx.exports` for same-script DO namespaces** (`CONTEXT`, `STATEFUL_WORKER` in
   project-worker): delete the `durable_objects.bindings` entries, keep `migrations`, reach namespaces as
   `ctx.exports.StreamDurableObject`. Needs the `enable_ctx_exports` compat flag. The cross-script
   `CONTEXT` binding in control-plane-shell must stay explicit (`ctx.exports` is per-script). This is
   optional taste, not urgent — do it only if the binding/class drift ever actually bites.
4. **When we grow a deploy/manifest script, copy fail-closed parsing**: enumerate the config keys the
   script understands and throw on anything else, with a golden-file test. Never `looseObject`-and-hope
   at the deploy boundary.
5. Repeated blocks across the three configs (compat date, future `observability`) are currently
   maintained by hand. The moment there's a third copy of any such block, write a 20-line
   `check-configs.mjs` that asserts uniformity (this is exactly the checker cloudflare-os skipped, and
   `gatekeeper-slack`'s missing observability block is what skipping it buys).

---

## 4. Dev servers

**What they do:** one command boots the fleet. `run-dev-server.js` (332 lines, plain Node, one real dep:
`jsonc-parser`) discovers workers by convention, generates patched gitignored `wrangler.dev.jsonc` files,
and execs a **single `wrangler dev -c a -c b -c c…` process** — all workers in one workerd, real service
bindings between them, one console. Secrets: one root gitignored `.dev.vars`, fanned out per worker.
Every worker package's own `dev` script **fails loudly**:
`echo "run 'pnpm dev-server' in the root directory instead" >&2 && exit 1` — 18 times over, killing the
"I started one worker and its service bindings dangle" trap. `run-local.mjs` adds a zero-config wrapper
that content-hashes tracked files into a stamp file to skip install/build when nothing changed.

**Adoption (we need ~5% of their machinery — our bindings are static, so no config generation):**

1. Add `packages/v3/dev.mjs` (or just a documented one-liner to start with):

   ```
   wrangler dev -c packages/v3/project-worker/wrangler.jsonc \
                -c packages/v3/control-plane-shell/wrangler.jsonc \
                -c packages/v3/control-plane/wrangler.jsonc
   ```

   The first `-c` is the "primary" worker (gets the port); the others register as service-binding /
   cross-script targets in the same workerd. This is the first time the FALLBACK hop and the
   cross-script `CONTEXT` write become locally exercisable end to end. (Prereq: item 2 in §3, so the
   SDK codegen runs without the hand-chained prefix — or keep the prefix in the fleet script.)

2. Once the fleet script exists, flip each package's `dev` script to the failing pointer, verbatim from
   their playbook. A lone `wrangler dev` in `control-plane-shell` half-works today (its `CONTEXT`
   binding dangles), which is exactly the trap the pointer prevents.
3. Don't build config generation, `.dev.vars` fan-out, or the content-hash stamp until there's a real
   third worker or a real secret in dev. Their 332 lines serve 18 workers with per-worker codegen; we
   have 3 and none of that yet.

---

## 5. Source layout & file size

**Measured** (357 src files, excluding generated/`.d.ts`/tests): median **98 lines**, p90 691, 24 files
over 1000. Half of all files are under 100 lines. The distribution is deliberately bimodal: per package,
**one spine file that IS the worker** (default fetch + all entrypoints + all DO classes:
`slack.ts` 1376/13 classes, `github.ts` 4059, backend `overseer.ts` 9520) surrounded by small
single-topic satellites (the vendor API wrapper, one file per helper concern). Directories are
aggressively **flat**: `workshop-backend` is 39 files with two subdirs, one file per domain noun
(`access.ts`, `sharing.ts`, `web-fetch.ts`). **No `src/utils/`, no deep trees, no barrel `index.ts`
re-exports anywhere.**

**Verdicts:** the flat one-file-per-noun layout, spine-plus-satellites, and the ban on utils-buckets and
barrels are genuinely good taste — review scope equals deploy scope and there's no "where does this
live" question. The 4–9k-line spines are _not_ taste; they're the convention running without an upper
bound. ~1400 lines (slack.ts) is about where the spine still works.

**Adoption:** v3 already has this shape (`worker.ts` spine + `core/*` satellites; flat; no barrels;
biggest file well under the slack.ts line). Keep two rules: when the spine grows past roughly the
slack.ts size, extract a _satellite_ (a named domain file), never a _layer_ (utils/helpers/lib); and
never add a barrel — importers name the file they mean.

---

## 6. Testing

**The headline: it's all vitest, all local workerd — zero tests against deployed infrastructure.** The
only `workers.dev` string in any test is a URL-parsing assertion. CI is `pnpm build && pnpm test`; no
deploy stage, no preview environments; the one place remote could sneak in says
`remoteBindings: false`. Even the "cluster" tier is a locally spun-up cluster. Three tiers:

1. **Pure-Node vitest** for libraries (`mcp-shared` — 19 files, the best-tested package in the repo —
   `error-reporting`, `typed-storage`) and frontend components. Plain `defineConfig`.
2. **In-workerd module tests** via `@cloudflare/vitest-pool-workers`' `cloudflareTest` vite plugin, so
   tests exercise the production runtime's real APIs. Two flavors, deliberately separate configs:
   - _unit flavor_ (`vitest.config.ts`, `__tests__/`): a **synthetic** miniflare env declaring only what
     tests need (e.g. one test DO binding), tests import modules directly;
   - _integration flavor_ (`vitest.integration.config.ts`, `__integration__/`):
     `cloudflareTest({ main, wrangler: { configPath: "./wrangler.jsonc" } })` boots the whole worker
     from its **checked-in config**. Honest cold-start economics in a comment: first test pays ~6s
     workerd boot (~3× on CI), so `testTimeout` is sized to the cold start.
3. **Multi-worker harness** (`@gadgets/integration-tests`): **wrangler's `createTestHarness`** boots the
   real backend _plus_ real gatekeepers, each from its own checked-in `wrangler.jsonc` — parsed with
   `jsonc-parser`, guarded by a zod `looseObject` validating _only the fields the harness touches_ ("a
   broken config fails here with the field named rather than surviving a cast and failing somewhere
   stranger"), patched in memory (bindings injected, `build.cwd` pinned). Real service bindings between
   real workers in one test process. Three load-bearing companions:
   - **`network-interceptor.ts`** patches `globalThis.fetch` and **throws on any un-mocked outbound
     request** — tests physically can't reach the internet by accident;
   - **`rpc-client.ts`** speaks capnweb over WebSocket to `/api` — the _same transport the browser
     uses_, no test backdoor;
   - a **fixture worker** (`fixtures/gatekeeper-test`, a real 2-DO gatekeeper) with documented
     departures from a shipping one; the harness is parameterized so a new vendor's suite = "point the
     harness at the package", not a fork.

   Operational rules: `fileParallelism: false` (fixed DO/KV namespaces race otherwise), 120s timeouts,
   and "**no test may assume a clean slate**" (escape assertions in `afterAll`, not `afterEach`).

**Their gap, honestly:** coverage is lopsided — the kernel (`workshop-backend`, 26 files) and the
security-shared code are well tested; **most gatekeepers have zero tests** (slack, github, google,
spotify). Consistent with their review-bar philosophy; still a hole, not a virtue.

**Adoption — current v3 state:** `project-worker` has 7 colocated `src/**/*.test.ts` files running in
**plain Node vitest** (tier 1: processor/patch/config/expression logic — no vitest config file, default
environment). There is no tier 2 and no tier 3; nothing exercises the FALLBACK hop, the cross-script
`CONTEXT` write, or a real workerd runtime. Instructions, in order:

1. **Add the tier-2 integration flavor to `project-worker`**: a `vitest.integration.config.ts` with
   `cloudflareTest({ main: "./src/worker.ts", remoteBindings: false, wrangler: { configPath: "./wrangler.jsonc" } })`
   and an `__integration__/` (or `src/*.integration.test.ts`) include. Keep the existing pure-logic
   tests in the default Node config — the two-config split is theirs and it's right: logic tests stay
   milliseconds, workerd tests pay the boot once. **First check: whether `cloudflareTest` boots a config
   with a `worker_loaders` binding** — the loader is the heart of this worker. Note their harness
   _deletes_ `worker_loaders` from configs before booting (`workshopConfig()` does
   `delete config.worker_loaders`), which is either "unsupported" or "unneeded" — find out which before
   betting the plan on it. Miniflare itself runs loaders locally (apps/os dev proves it), so worst case
   the loader-bearing worker runs under `cloudflareTest` with a miniflare-level loader config rather
   than the harness.
2. **Add `packages/v3/integration-tests`** (pure lib, no wrangler.jsonc) once tier 2 exists: a
   `harness.ts` on wrangler's `createTestHarness` booting all three workers from their checked-in
   configs — project-worker primary, control-plane-shell + control-plane as siblings. This is the first
   real test of FALLBACK and the cross-script `CONTEXT` append. Copy their zod-`looseObject`
   read-validate-patch approach and their `fileParallelism: false` + generous timeouts.
3. **Copy the two companions early, they're cheap and stop whole bug classes:** a fail-closed fetch
   interceptor (throws on un-mocked egress — for us this also asserts the egress door's
   `{{secret:…}}` substitution never leaks to an unexpected origin), and a capnweb-over-WS test client
   dialing `/api` exactly like a real client (we already have prove-script precedents:
   `prove_connect.mjs` / `prove_1000.mjs`; the harness client is their vitest-ified form).
4. **Adopt the "no clean slate" rule** from day one of tier 3: DO storage persists across tests in one
   harness boot; write tests that own their keyspace (fresh `projectId` per test) rather than truncating.
5. Deployed-environment smoke stays what it is today — the BUILD-LOG's per-increment `workers.dev`
   proofs — and out of vitest. That separation is theirs too, and it's correct.

---

## 7. Deliberately NOT copied

| Their practice                                                                                        | Why not                                                                                                  |
| ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Committed per-worker `worker-configuration.d.ts` (18 × ~14.7k lines, no regen script)                 | Drifts immediately; hand-written `Env` interfaces are small and reviewed. Generate in CI if ever needed. |
| tsconfig `paths` alongside exports maps                                                               | Two resolution schemes, hand-synced, inconsistent; cost them type-aware linting. Exports-only.           |
| Dist-built shared packages (`typed-storage`)                                                          | The one build-order landmine in their repo; all v3 shared code ships as source.                          |
| Copy-paste skeleton culture (8 near-identical `observability.ts`, helpers pasted into 16 gatekeepers) | At 16 siblings it's a tax; at our scale the shared package + a conformance check covers it.              |
| Package name ≠ directory name (`gatekeeper-slack` → `@gadgets/slack-gatekeeper`)                      | Pure friction; v3 names match directories.                                                               |
| Per-package UI build systems bolted into `build`/`test`/`deploy` scripts                              | If a v3 worker ever grows a UI, its build goes behind wrangler's `build.command`, not into every script. |
