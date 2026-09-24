# Outstanding for the owner, 2026-09-24

Everything still open for you after the overnight review and today's work, in one place. It replaces the overnight review document from #2955: whatever you already decided, or what merged today, is gone from it. Every file reference was checked against main at `4fc3fb120`.

The PR that carries this file also carries the merge-queue workflows ([Proposals](#proposals-with-implementation)). Merge the PR when you want those on main, or close it. Once the items here are done or filed, delete this file.

## TL;DR

**What happened today** (all merged):

1. **Production was recreated on clean names.** The Worker is now `os-prd`, the preview parent `os-preview`, and the Doppler project `os` (it was `project-worker`). Five seeds were restored and every site serves the same bytes as before ([#2987](https://github.com/iterate/iterate/pull/2987)). The old Worker `os-next-prd` is kept without routes, as the rollback.
2. **Review PRs merged:** backwards compatibility in persisted and auth state ([#2950](https://github.com/iterate/iterate/pull/2950)), validation gaps ([#2951](https://github.com/iterate/iterate/pull/2951)) and the SDK renames ([#2953](https://github.com/iterate/iterate/pull/2953)). `iterate/next/*` is now `iterate/*`, and the CLI and menu bar are `@iterate-com/cli`, with login on oauth4webapi ([#3004](https://github.com/iterate/iterate/pull/3004)). `configs-next/` is `configs/` ([#3000](https://github.com/iterate/iterate/pull/3000)), and lane, door and seam are gone from the code ([#3022](https://github.com/iterate/iterate/pull/3022)).
3. **Lint grandfathering is gone.** About 1,500 violations were fixed, with no exclusions ([#2998](https://github.com/iterate/iterate/pull/2998)).
4. **Misha's work is back:** `rules/**` plus `createFailing` pins ([#2960](https://github.com/iterate/iterate/pull/2960)), the CI report viewer plus main's traces and Playwright reports ([#2969](https://github.com/iterate/iterate/pull/2969)), the spec operator handle ([#2965](https://github.com/iterate/iterate/pull/2965)), and CI telemetry to PostHog at workflow and job level ([#2962](https://github.com/iterate/iterate/pull/2962)).
5. **Lost features are back:** one-click preview sign-in ([#2966](https://github.com/iterate/iterate/pull/2966)), the ⌘K palette ([#2991](https://github.com/iterate/iterate/pull/2991)), org invite links ([#2993](https://github.com/iterate/iterate/pull/2993)), `pnpm getin` ([#2994](https://github.com/iterate/iterate/pull/2994)), the dash activity explorer ([#2985](https://github.com/iterate/iterate/pull/2985)), plus [#2986](https://github.com/iterate/iterate/pull/2986), [#2989](https://github.com/iterate/iterate/pull/2989), [#2990](https://github.com/iterate/iterate/pull/2990), [#2992](https://github.com/iterate/iterate/pull/2992) and [#2995](https://github.com/iterate/iterate/pull/2995).
6. **CI reliability:** about 30 fixes (#2971–#3028). Brand-new previews now wait until their Durable Objects answer ([#3011](https://github.com/iterate/iterate/pull/3011)), and a conflicted PR gets a red check ([#3014](https://github.com/iterate/iterate/pull/3014)). On a small PR in calm hours, the first push now goes all green about 90% of the time; it was about 82%.
7. **AI spend:** PR and main e2e runs use a fake model provider, and real models run once a day ([#3012](https://github.com/iterate/iterate/pull/3012)). The preview AI Gateway cap is back at $30 a day.
8. **Guards:** the latency guard runs every 3 h and on main pushes ([#2997](https://github.com/iterate/iterate/pull/2997)). Everything is light mode, and Kit has analytics ([#2968](https://github.com/iterate/iterate/pull/2968)). The Kit firmware no longer polls ([#2970](https://github.com/iterate/iterate/pull/2970)).
9. **Less code:** one entity lifecycle for repos and workspaces ([#3021](https://github.com/iterate/iterate/pull/3021)), one git protocol codec ([#3023](https://github.com/iterate/iterate/pull/3023)), and the test harness is out of app code ([#3024](https://github.com/iterate/iterate/pull/3024)).
10. **This PR:** the merge queue, ready to switch on. Nothing changes until you apply the ruleset.

**Already decided, so not in this file:** keep `release.yml`; keep the menu bar's approval code; the Start-app skeleton is fine as it is; keep the petshop's extra surfaces and test them (done in #2979); keep the lane/door/seam rule as an AI-review rule with the code compliant (done in #3022); no dark mode; Kit gets analytics; no polling; the Kit firmware release contract is fine (and its tag ruleset exists); rename the prd resources and the Doppler project (done in #2987); CI telemetry per job, not per test (done in #2962); per-test results go to Parquet (draft #2984).

**Left for you:**

- 10 [decisions](#decisions-for-you), each with a recommendation. The ones with the most at stake are 2 (agents authority), 3 (subrequest depth in agent turns, which reaches prd) and 5 (the SDK line, whose PR now conflicts).
- The [owner actions](#things-only-you-can-do): the prd account cleanup, Doppler, domains, devices, Kit and publishing.
- The [merge queue](#proposals-with-implementation), to discuss with Misha. This PR implements it; switching it on takes one `gh api` call after a trial run.

## Decisions for you

| #   | Decision                                                                                            | Recommendation                                                     |
| --- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 1   | [Merge queue and Preview OS gating](#1-merge-queue-and-preview-os-gating)                           | Yes: Lint and Test first, the Preview OS gate once e2e is steadier |
| 2   | [Agents authority: a jailed context reaches root through `itx.agents`](#2-agents-authority)         | (a) the platform tells the facet its caller                        |
| 3   | [Agent turns nest until Cloudflare refuses them](#3-agent-turns-nest-until-cloudflare-refuses-them) | (b) the facet returns its events with the delivery                 |
| 4   | [#3008, OAuth grants in the control plane](#4-3008-oauth-grants-in-the-control-plane)               | Keep it, plus a small follow-up                                    |
| 5   | [The SDK/platform line (#3018)](#5-the-sdkplatform-line-3018)                                       | Adopt it; rebase it without its git part                           |
| 6   | [The residency watchdog: page or delete](#6-the-residency-watchdog-page-or-delete)                  | Page on a burst                                                    |
| 7   | [Sign off new environment variables](#7-sign-off-new-environment-variables)                         | Yes to all three                                                   |
| 8   | [One-click preview sign-in on a public repo](#8-one-click-preview-sign-in-on-a-public-repo)         | Keep it as merged                                                  |
| 9   | [The last three polling loops](#9-the-last-three-polling-loops)                                     | Push for the screen; keep the other two, with a reason             |
| 10  | [Product restores and small calls](#10-product-restores-and-small-calls)                            | See the table                                                      |

### 1. Merge queue and Preview OS gating

You said to skip this until you have talked to Misha. The full proposal, the implementation (in this PR) and the switch-on procedure are in [Proposals](#proposals-with-implementation). The decision has two parts:

- **Turn the queue on?** Recommendation: **yes**, requiring Lint and Typecheck and Test in the queue.
- **Require Preview OS too?** Recommendation: **later.** Add `Preview OS / gate` once the Preview OS e2e job (which retries a failed row once) passes about 98% of the time; in calm hours today it is about 93%. Requiring it now would block roughly one preview PR in fifteen on a flake.

### 2. Agents authority

**Context.** [#2964](https://github.com/iterate/iterate/pull/2964) fixed parent links for repos and workspaces: the collection now writes the link itself, from the caller's context as the platform stamped it. Agents are different. The agents collection runs at `/` with root authority and cannot see who called it. Every context linked under the root inherits `itx.agents`, and `at(base)` is public. Four `createFailing` pins in [`apps/agents/e2e/inherited-capabilities.e2e.test.ts`](../apps/agents/e2e/inherited-capabilities.e2e.test.ts) show it. From a context jailed at `/jail`:

```js
await itx.agents.create("/jail/a"); // links the new agent to "/", not "/jail"
await itx.agents.create("./a"); // lands at "/a", not "/jail/a"
await itx.agents.get("./x").append(linkRow("./x", "/")); // written with root authority
await itx.voice.setupVoiceAgent({ streamPath: "/jail/v" }); // links the voice agent to "/"
```

**Options.**

- **(a) The platform passes the caller's context to the facet.** A caller placeholder in the rewrite rule would let the root's rule read `…at(<caller>)`. The collection then limits `get`, `create` and `append` to that base. This is how the platform already treats repos and workspaces.
- **(b) The agents app stops lending root authority** to the contexts linked under it. That is simpler, but a linked context then has no `itx.agents` at all unless something grants it one explicitly.

**Recommendation: (a).** Every userspace collection will need to know its caller, not only agents, and the platform already stamps callers for its own collections.

**If yes:** a PR adds the caller placeholder to the rewrite rule, and makes `AgentCollectionRpcTarget` scope `create`, `get` and `append` to it (`apps/agents/runtime/collection.ts`). The four pins then turn into plain tests, and they fail if the gap comes back. **Until then**, a context you jail must also mask `itx.agents` and `itx.voice`.

### 3. Agent turns nest until Cloudflare refuses them

**Context.** This was found by [#3019](https://github.com/iterate/iterate/pull/3019), and it reaches prd. A Durable Object counts its outgoing call depth from its newest in-flight incoming call (workerd `IoContext::getCurrentIncomingRequest`). Each agent turn's script request comes back from the facet a few hops deeper, so turns nest. A probe measured how many nested `itx.run` levels a script had left. From a session the answer was 9; inside the agent loop it went `8, 6, 5, 4, 9, …` as turns stacked. At the bottom, Cloudflare answers "Subrequest depth limit exceeded". That refusal shows only in the agent's own log, never in Workers Logs (a 7-day search of `os-prd` and `os-preview` found nothing). THE JAIL row is pinned with `createFlake(test, /Subrequest depth limit exceeded/)` ([`apps/agents/e2e/agents.e2e.test.ts:563`](../apps/agents/e2e/agents.e2e.test.ts#L563)). It hits the pin about 15% of the time alone on a busy preview.

**Options.**

- **(a) Run scripts from the context's alarm**, so each turn starts from a fresh incoming call. The cost is an alarm round trip per run. Alarms are themselves late: scheduled deadlines fire 40–60 s late in about 1 run in 10 ([#3010](https://github.com/iterate/iterate/pull/3010) is open for that).
- **(b) The facet returns its events with the delivery** instead of calling back into its host. Nothing nests, and nothing new waits on an alarm.

**Recommendation: (b).** It removes the nesting at its source, and it does not tie every agent turn to alarm timing while that is still broken.

**If yes:** a PR changes the facet delivery contract (an API change, which is why it needs you). It adds a test in `apps/os/__workers-tests__` that runs 30 turns in one context and asserts the depth budget stays flat, and it removes the `createFlake` wrapper from THE JAIL.

### 4. #3008, OAuth grants in the control plane

**Context.** You asked to understand [#3008](https://github.com/iterate/iterate/pull/3008) before anything changes it. In short:

- `@cloudflare/workers-oauth-provider` 0.10.3 rewrites one KV record per login at consent, at code exchange and at every refresh. KV guarantees a write is visible only at the location that made it.
- A refresh right after login could therefore read the grant as it was before the exchange, and get `invalid_grant`. It happened 34 times in Workers Logs, across 20 previews. A cross-location test failed 25 of 25 before the fix and passed 20 of 20 after.
- #3008 moves only the `grant:` keys into a SQLite table in the `CONTROL_PLANE` singleton, through a KV-shaped adapter. Tokens and clients stay in KV. The per-request bearer check never touches the singleton; login and hourly refresh each add about two calls to it.
- An agent merged it with no review. `docs/jonasland-rules.md` asks a human to approve schema and architecture changes, so this is that approval, after the fact.

**Recommendation: keep it, and merge a small follow-up.** Reverting brings the flake back and strands every grant made since. A Durable Object per user (upstream [#312](https://github.com/cloudflare/workers-oauth-provider/pull/312)) scales better, but it is 15.6k lines, unmerged and built on two other open PRs.

**If yes**, the follow-up is about +40 to +60 lines, almost all tests:

- [`control-plane/oauth-grants.ts:79`](../apps/os/src/control-plane/oauth-grants.ts#L79): list grants with a range query instead of `substr(key, 1, ?) = ?`, which scans the table (7.7 ms against 0.1 ms at 100k rows).
- [`oauth-store.ts:28`](../apps/os/src/oauth-store.ts#L28): rename `oauth.grant-store-retry` to `oauth.platform-failure-grant-store-retry`, so the prd fault alarm counts it (`docs/engineering-invariants.md`). Do the same for `rpc.ts`'s `oauth.live-authorization-retry`, and add a test for the retry.
- Correct the adapter's header comment: an upgrade would not "fail loudly". Upstream `main` stores a `metadata` field on grants that the adapter drops, and any key outside `grant:` that the library starts rewriting would stay in KV silently.

Outside the code: post the cross-location repro on upstream #312. Also, sign-in challenges still live in `OAUTH_KV` (`password-and-code-sign-in.ts`) and have the same stale-read problem.

### 5. The SDK/platform line (#3018)

**Context.** You asked for a proposal PR on where the SDK stops and the platform begins: [#3018](https://github.com/iterate/iterate/pull/3018). Its answer: the SDK (`iterate`) is the programming model, and the platform is its first user. The line is where code runs. What user code runs, plus the contracts both sides speak, goes in `iterate`. What only the platform's Worker runs stays in apps/os. Private code that several apps share goes in `packages/shared`. The branch moves the dispatch and caller code into apps/os, gives the SDK its own processor tests behind `iterate/stream/test-support`, and adds a lint rule that keeps the SDK and first-party apps from importing `apps/os/src`. A private core package behind a thin SDK is rejected: tRPC's `unstable-core-do-not-import` shows where that ends up.

**What changed since.** [#3023](https://github.com/iterate/iterate/pull/3023) merged "one git protocol implementation" in the opposite direction: apps/os's codec moved to `@iterate-com/shared/git-wire`, while #3018 kept it in apps/os and deleted the shared copy. #3018 now conflicts with main (`mergeStateStatus: DIRTY`).

**Recommendation: adopt it.** Rebase #3018, drop its git part (#3023 settled that), then publish it with the other published-surface changes as one version bump (0.5.0).

**If yes:** tell the PR to rebase and merge. External code loses `iterate/expression`'s dispatch half and the caller half of `iterate/principal`. Nothing outside apps/os imports either today.

### 6. The residency watchdog: page or delete

**Context.** [#2961](https://github.com/iterate/iterate/pull/2961) moved residency into [`context/residency.ts`](../apps/os/src/context/residency.ts), and [`apps/os/docs/residency.md`](../apps/os/docs/residency.md) now explains all seven mechanisms together. The watchdog logs `context.held-resident-while-idle` and appends an event ([`residency.ts:235`](../apps/os/src/context/residency.ts#L235)). Nothing pages on it: `scripts/ci/prd-fault-alarm.ts` pages on 5xx, `platform-failure` heals and errors.

**Recommendation: page on a burst.** A context held resident while idle is exactly the Durable Object cost that paged on 2026-09-21. The hourly DO-duration alarm sees that cost, but only as a total an hour later.

**If yes:** a PR adds the event to `prd-fault-alarm.ts`'s patterns, with a threshold such as 5 contexts in 15 minutes and a table test. That is about 20 lines. **If no:** delete the watchdog and its event; the page stays.

### 7. Sign off new environment variables

`docs/jonasland-rules.md` asks a human to sign off new environment variables. Three were added:

| Variable                                                        | Added by                                              | Shape and use                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ITERATE_APP_ORIGINS`                                           | [#2963](https://github.com/iterate/iterate/pull/2963) | A Worker var on each client app: JSON, `{"dash":"https://dash.iterate.com","agents":"…",…}`. Prd values come from `envs.ts` (`scripts/lib/start-app.ts:117`). A PR preview swaps in its own app previews (`apps/os/scripts/preview-config.ts`), so a preview's dash links to the same PR's agents, notes and voice. There is no fallback to prd. |
| `E2E_REAL_MODELS`                                               | [#3012](https://github.com/iterate/iterate/pull/3012) | Test-only, `"1"` or unset. It opts in the `REAL:` rows that pay for model inference. Only `os-real-model.yml` sets it, once a day; soaks strip it (`apps/os/e2e/support/project-host.ts:20-26`).                                                                                                                                                 |
| `PREVIEW_GATE_EVENT`, `_CHANGES`, `_TOUCHED`, `_DEPLOY`, `_E2E` | this PR                                               | Step inputs of the `gate` job only: the event name and the needed jobs' results, for `scripts/ci/preview-os-gate.ts verdict`. They are set nowhere else.                                                                                                                                                                                         |

**Recommendation: yes to all three.** They are named for what they carry, and each has one writer.

### 8. One-click preview sign-in on a public repo

**Context.** [#2966](https://github.com/iterate/iterate/pull/2966) put a `Sign in ↗` link for each app in every PR body. One click signs a browser in as `pr<N>@preview.iterate.test` and lands inside project `pr<N>`. The repo is public, so anyone who reads a PR can do the same. Here is what bounds it:

- The link is HMAC-bound to that preview's origin and that one email.
- It expires after 14 days, and a fresh one is minted on every push.
- It dies with the PR.
- The Worker refuses to start with test links on unless its address is `*.workers.dev` or localhost ([`apps/os/src/app-config.ts:364-368`](../apps/os/src/app-config.ts#L364-L368)), so prd cannot enable them.

What is new is that an anonymous visitor can spend that preview's compute (the AI binding, browser rendering, worker loaders) through the seeded project. The old #2485 had the same exposure.

Also done: consent is skipped, but only for a session a link started, and only for the sibling app previews named in the link. Everyone else still sees the Allow page. And every PR run deploys all five apps (`PREVIEW_APPS: ${{ inputs.apps || 'all' }}`, [`preview-os.yml:174`](../.depot/workflows/preview-os.yml#L174)), so "always deploy the dash preview" needs no change.

**Recommendation: keep it as merged.** The tokens expire, previews are deleted when their PR closes, and a real model call from a preview is capped by the $30-a-day gateway rule. **If no:** post the links only in the CI log or a private Slack thread, or show them only after a GitHub sign-in check.

### 9. The last three polling loops

You said there should be no polling. [#2970](https://github.com/iterate/iterate/pull/2970) removed the Kit face's poll and the voice sender's 1 s timer. Three loops are left, and each needs a bigger change:

| Where                                                                             | What polls                                                                                 | Recommendation                                                                                                                                                                              |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`apps/agents/voice/worker.ts:117-123`](../apps/agents/voice/worker.ts#L117-L123) | `screen.status()` every 150 ms until the e-paper screen finishes refreshing                | **Replace with a push.** The firmware either answers the draw call only once the refresh is done, or reports the finished refresh as an event. Either way it is a firmware change.          |
| [`apps/os/src/rpc.ts:166`](../apps/os/src/rpc.ts#L166)                            | each signed-in WebSocket re-checks its grant and membership every 30 s                     | **Keep, and name the reason in a comment.** A push would need every revocation to reach live sockets in every isolate. The 30 s bound is the revocation guarantee.                          |
| [`apps/os/src/grants.ts:177`](../apps/os/src/grants.ts#L177)                      | up to 40 tries, on the local worker only, until local KV shows a just-created OAuth client | **Keep.** It runs only for a local issuer, at most 40 × 50 ms, because local KV has no read-your-write and no push. Or delete it when local dev stops registering its console client in KV. |

### 10. Product restores and small calls

| Question                                                                                                                                                                                                                                                                                                                                                  | Recommendation                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Org invitations** ([#2993](https://github.com/iterate/iterate/pull/2993)): copyable links only, or also email them?                                                                                                                                                                                                                                     | **Links only for now.** Email needs a sender domain on the Email Sending binding and a per-org send cap against abuse.                                                                                                                                                                       |
| **Operator browser sessions for prd support** (#1929 `session create --project <slug> --open`, the #1473 /admin view)                                                                                                                                                                                                                                     | **Not now.** It would give support a browser path into any customer's project in prd, which needs a design first: one-shot, origin-bound, project-scoped, audited, minted with the admin bearer.                                                                                             |
| **A first-class AI interception API** (`itx.ai.intercept`, `intercepted/*` models from #2523/#2528, lost in #2837)                                                                                                                                                                                                                                        | **No.** #3012 and THE JAIL fake the model by shadowing `itx.ai` in the test's own project, which is enough for deterministic agent tests.                                                                                                                                                    |
| **Deferred restores:** bundle-size delta in the PR table (#1753), config-repo reset to the template (#2245), a browser itx REPL (#2469), an OAuth "Connect" preset in the secrets sheet, workspace file review with comments (#2367), an account chooser (#1633), CLI device-code login (#1042), a "debug info" sheet, a `-w` worktree picker for `getin` | **Leave deferred**, unless one of them bites.                                                                                                                                                                                                                                                |
| **Deliberately not restored:** the mobile app with its QR, deep link and one-tap sign-in; the @claude GitHub Actions workflow; the `.superset`/`.cursor` bootstrap configs; event-type docs pages; the fixed-OTP carve-out; the `login_hint` "Continue as" button                                                                                         | **Confirm.** Each was replaced or has no subject left.                                                                                                                                                                                                                                       |
| **How commit hooks spot Claude Code**: `CLAUDE_CODE_CHILD_SESSION=1` ([`packages/cli/src/coding-agent.ts:15`](../packages/cli/src/coding-agent.ts#L15)), not `CLAUDECODE`                                                                                                                                                                                 | **Keep.** `CLAUDECODE` is also set in IDE terminals where a person types, so it would block your own `--amend`. Codex is not detected yet: add `CODEX_THREAD_ID` when someone uses it here.                                                                                                  |
| **A token endpoint 500 during a secret's OAuth refresh** reaches the caller as the provider's 401, the same as a revoked token (pinned by #2979)                                                                                                                                                                                                          | **Answer 502.** An outage should not read as "reconnect your account". A small change, plus flipping the pinned test.                                                                                                                                                                        |
| **The petshop's test-control routes, their header and their Doppler secret** (`apps/dummy-petshop/src/worker.ts`, the Doppler project `dummy-petshop`) still use a word the terminology rule bans. #3022 left them because the shop deploys only from main while PR previews call it.                                                                     | **Rename them in one PR** that changes the shop and the e2e client together (for example to `/__test-control/*`), with no alias. The shop deploys from main when that PR merges, so an open PR's e2e fails against it until the PR rebases: merge it when few PRs are open. About 125 lines. |
| **Main e2e on a brand-new preview for every push** (#2920): Cloudflare's fresh-preview instability leaves about 1 red run in 20 after #3011's gate                                                                                                                                                                                                        | An agent is moving main, latency and real-model runs to stable preview names, redeployed in place. That reverses #2920's one-preview-per-push design: **object if you want to keep it.**                                                                                                     |

## Things only you can do

### Production account (`04b3b57291ef2626c6a8daa9d47065a7`)

Listed read-only today at about 12:00 UTC. Nothing on main binds any of these on this account. Deleting a Worker with `?force=true` also deletes its Durable Object namespaces. The API refuses to delete a non-empty R2 bucket or Artifacts namespace, so empty those first.

| Delete                                                                                                                                                                                                            | Why                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Worker `os-next-prd` (9 DO namespaces), KV `project-worker-prd-oauth` and `project-worker-prd-itx`, R2 `project-worker-prd-files`, Artifacts `project-worker-prd-repos` (105 repos)                               | The pre-cutover prd, kept as the rollback. It has logged nothing since 08:37 UTC.                                  |
| Worker `os-prd-account-e2e` (18 DO namespaces), KV `os-prd-account-e2e-main-401b24a-{itx,oauth}-kv`, R2 `os-prd-account-e2e-main-401b24a-files`, Artifacts `os-prd-account-e2e-main-401b24a-repos` (52 repos)     | The prd-account e2e that #2933 removed                                                                             |
| Worker `cf-artifact-viewer-prd` (artifacts.iterate.com) and Artifacts `os-prd-repos` (1 repo)                                                                                                                     | The legacy artifact viewer; it is the only thing binding `os-prd-repos`                                            |
| Artifacts `project-worker-repos` (5 repos), R2 `iterate-files`, Worker `dummy-petshop-prd`                                                                                                                        | Legacy. The current petshop is the Worker `dummy-petshop`.                                                         |
| Custom hostnames `hardway.mmkal.com`, `kaletsky.com`                                                                                                                                                              | Stale Cloudflare for SaaS hostnames                                                                                |
| **Your call:** Workers `auth-prd` (D1 `auth-prd-auth-db`), `semaphore-prd` (D1 `semaphore-prd-resources`), `streams-example-app-prd`, `tunnels-prd`, `docs`, `mobile-website-prd` (R2 `mobile-website-prd-state`) | Legacy platform apps that #2837 deleted from the repo; still deployed. Check their routes first.                   |
| **Your call:** `alchemy-state-store`, `captun-public`, `cloudflare-os-*` (4), `iterate-auth-example`, `iterate-jail-external-spa`, `revhub`, `tasks`, `tasks-collab-preview`                                      | Experiments that are not in this repo. `alarm-loader-facet-repro` stays, because `context/facet-host.ts` cites it. |

```bash
doppler run --project os --config prd -- bash
# inside that shell:
[ "$CLOUDFLARE_ACCOUNT_ID" = 04b3b57291ef2626c6a8daa9d47065a7 ] || exit
cf() { curl -sS -X "$1" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID$2"; }
ok() { jq -c '{success, errors: [.errors[]?.code]}'; }
kv_id() { cf GET "/storage/kv/namespaces?per_page=100" | jq -r --arg t "$1" '.result[] | select(.title == $t) | .id'; }
empty_r2() { # every object, then the bucket
  while keys=$(cf GET "/r2/buckets/$1/objects?per_page=1000" | jq -r '.result[]?.key | @uri') && [ -n "$keys" ]; do
    for k in $keys; do cf DELETE "/r2/buckets/$1/objects/$k" >/dev/null; done
  done
  cf DELETE "/r2/buckets/$1" | ok
}
empty_artifacts() { # every repo, then the namespace
  while repos=$(cf GET "/artifacts/namespaces/$1/repos?limit=200&page=1" | jq -r '.result[]?.name | @uri') && [ -n "$repos" ]; do
    for r in $repos; do cf DELETE "/artifacts/namespaces/$1/repos/$r" >/dev/null; done
  done
  cf DELETE "/artifacts/namespaces/$1" | ok
}

cf DELETE "/workers/scripts/os-next-prd?force=true" | ok
cf DELETE "/storage/kv/namespaces/$(kv_id project-worker-prd-oauth)" | ok
cf DELETE "/storage/kv/namespaces/$(kv_id project-worker-prd-itx)" | ok
empty_r2 project-worker-prd-files
empty_artifacts project-worker-prd-repos

cf DELETE "/workers/scripts/os-prd-account-e2e?force=true" | ok
cf DELETE "/storage/kv/namespaces/$(kv_id os-prd-account-e2e-main-401b24a-itx-kv)" | ok
cf DELETE "/storage/kv/namespaces/$(kv_id os-prd-account-e2e-main-401b24a-oauth-kv)" | ok
empty_r2 os-prd-account-e2e-main-401b24a-files
empty_artifacts os-prd-account-e2e-main-401b24a-repos

cf DELETE "/workers/scripts/cf-artifact-viewer-prd?force=true" | ok
empty_artifacts os-prd-repos
empty_artifacts project-worker-repos
empty_r2 iterate-files
cf DELETE "/workers/scripts/dummy-petshop-prd?force=true" | ok

# the two stale custom hostnames, wherever they live
for zone in $(curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones?account.id=$CLOUDFLARE_ACCOUNT_ID&per_page=50" | jq -r '.result[].id'); do
  for host in hardway.mmkal.com kaletsky.com; do
    id=$(curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
      "https://api.cloudflare.com/client/v4/zones/$zone/custom_hostnames?hostname=$host" | jq -r '.result[0]?.id // empty')
    [ -n "$id" ] && curl -sS -X DELETE -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
      "https://api.cloudflare.com/client/v4/zones/$zone/custom_hostnames/$id" | ok
  done
done
```

### Dev/preview account (`376ef7ed81b0573f93524de763666c15`)

You asked for every old preview resource to go. A cleanup workflow is deleting its reviewed list now: 369 items, including `os-next-preview` with all its previews and resources, the legacy slot fleet, and the 18 `os-preview-<n>-repos` namespaces. Those namespaces hold 251,163 repos and take hours at a throttled rate. Its files and results are in `/home/jonas/iterate-preview-cleanup-2026-09-24/`. Nothing there needs you except `ask-list.md`:

- **Dev namespaces and tunnels.** `os-dev-{jonas,misha,rahul,localhost}-repos` (legacy per-developer), `os-next-dev-repos` (local dev before #2987), and 9 legacy dev tunnels, all down. Recommendation: delete, once every checkout has pulled #2987.
- **Owner unclear.** `env-manager` with `env-manager-prd` and `envs.iterate-dev.com`; `alchemy-state-store`; Artifacts `os-repos` (11,534 repos) and `minimal-itx-v3-repos`. Neither Worker is in this repo's history.
- **`auth-dev-global`**, with its D1 (2.2 MB of dev auth data) and the route `auth.iterate-dev.com/*`. This is the legacy apps/auth dev instance, not a preview. Deleting a D1 cannot be undone.
- **`os-next-preview-pr2817-…-repos`.** Cloudflare refuses to delete it, answering "not empty" with no repos listed (409/10202). Add it to the report to Cloudflare below. The nightly sweep no longer touches it ([#2983](https://github.com/iterate/iterate/pull/2983), and it now sweeps `os-preview`).

The looping onboarding agents on the legacy `preview_<n>` environments (about $1.54 a day of `gpt-5.6-terra`) are **no longer running**. Their last gateway call was at 2026-09-23 12:15 UTC, and none of the last 1,000 calls (back to 16:19 UTC that day) comes from them.

### Domains

- **40 legacy preview domains** (`iterate-preview-1..20.com` and `.app`). Their 78 Worker routes are deleted. The zones cannot go while the domains are registered with Cloudflare Registrar, and all 40 auto-renew on 2027-04-21. **Decide:** turn auto-renew off, then delete the zones once they can go, with a token that can delete zones (`/home/jonas/iterate-preview-cleanup-2026-09-24/delete-preview-zones.sh`). The token in Doppler can read registrations; whether it can change them is untested. The older `PUT …/registrar/domains/{name}` stops working on 2026-09-27; this is the current endpoint:

  ```bash
  A=376ef7ed81b0573f93524de763666c15
  for n in $(seq 1 20); do for tld in com app; do
    d="iterate-preview-$n.$tld"
    curl -sS -X PATCH "https://api.cloudflare.com/client/v4/accounts/$A/registrar/registrations/$d" \
      -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "content-type: application/json" \
      --data '{"auto_renew":false}' | jq -c --arg d "$d" '{d: $d, success, errors, auto_renew: .result.auto_renew}'
  done; done
  ```

  The dashboard does the same: Domain Registration → Manage Domains → each domain → Configuration → Auto-renew. The details are in `domains-log.md` in that directory.

- **20 zones on dev/preview that nobody has explained**, registered 2026-04-21 and 2026-04-27 with default DNS only (`bopers.com`, `bosync.com`, `brulf.com`, …, `bysors.com`). Say what they are for, or remove them.
- **8 legacy dev zones** (`iterate-dev.{app,com}`, `iterate-dev-{jonas,misha,rahul}.{app,com}`): the old platform's per-developer hostnames. Delete them with the dev tunnels.

### Doppler

Checked read-only today:

```bash
# 1. The legacy project the prd rename set aside. Nothing in the repo reads it.
doppler projects delete os-legacy-2026-04 --yes

# 2. The flake dashboard's GitHub App key: copy it to _shared/prd, where account-wide tooling reads
#    (envs.ts), then change .depot/workflows/flake-dashboard.yml:51-52 to `--project _shared --config prd`
#    in a one-line PR. Only then retire os-legacy-backup, which still holds the legacy platform's
#    Stripe, Fly, Daytona and Slack secrets.
for k in GITHUB_APP_ID GITHUB_APP_PRIVATE_KEY; do
  doppler secrets get "$k" --plain --project os-legacy-backup --config prd |
    doppler secrets set "$k" --project _shared --config prd >/dev/null # prints values otherwise
done

# 3. Stale configs: the legacy slots' and per-developer ones.
for c in dev_jonas dev_misha dev_rahul preview_2 preview_3 preview_4 preview_5 preview_6 preview_7 preview_8 preview_9; do
  doppler configs delete "$c" --project os --yes
done
for c in preview_1 preview_2 preview_3 preview_4 preview_5 preview_6 preview_7 preview_8 preview_9 preview_10; do
  doppler configs delete "$c" --project _shared --yes
done

# 4. Your checkouts. Here, apps/os still points at project-worker/dev, which no longer exists.
cd ~/src/github.com/iterate/iterate/apps/os && doppler setup --project os --config dev
```

Projects that nothing in this repo reads: `ai-engineer-workshop`, `auth`, `channel-agent-poc`, `cloudflare-os`, `docs`, `env-manager`, `events`, `example`, `ingress-proxy`, `iterate-com`, `mini-agent`, `project-v4`, `semaphore`, `streams-example-app`, `tunnels`. Some may serve other repos (`env-manager` still has a Worker), so check before you delete. The DO duration alarm reads `os/dev` and `os/prd` ([`scripts/ci/do-duration-alert.ts:177`](../scripts/ci/do-duration-alert.ts#L177)). After the rename that is the platform's project, and it works: the 11:41 UTC probe was green.

### People and devices

- **Every session, grant and token from before the cutover is gone.** Voice and Kit devices need setting up again, and MCP clients and `iterate login` users need to sign in again. At 08:37 UTC, a client with no user agent was calling `os.iterate.com/api` every ~31 s with a pre-cutover token and getting 401. It is most likely a Kit or voice device, and it stops once that device is set up again.
- **Agent histories and voice device rules were not part of the seeds.** garple's agents app shows "No agents yet".

### Kit

- **Bench-flash one board.** No board has been flashed from a release. #2970 and #2979 changed the Waveshare firmware (mouth shapes now come from the audio; the silent-output diagnostic is gone), and only the ESP-IDF build has compiled it.
- **The tag ruleset is done.** "Kit firmware tags" (id 23923281) was created at 06:52 UTC, and publishing works under it: `kit-firmware/zectrix-note4/002653-2026-09-24-33eb786` was published at 11:40 UTC.
- **The `kit-preview` parent is still stale.** It answers 404 for `/firmware/waveshare/002592-2026-09-24-0aaa8ae/manifest.json`, which `k.iterate.com` serves with 200. `kitEnvs.preview.dopplerConfig` is `"preview"`, but the Doppler project `kit` has no `preview` config (only dev, dev_jonas, dev_misha, dev_rahul, stg and prd). **Recommendation:** have Main OS e2e redeploy the app parents on each main push, the way it already redeploys `os-preview` ("deploy the preview parent from main"). That is a small workflow PR, and I can do it on a yes.

### Publishing

- **npm:** `iterate@0.4.0` and `@iterate-com/cli@0.4.0` are unpublished (npm has `iterate@0.3.0`, and nothing under `@iterate-com/cli`). Until they are published, `npx iterate` gets the old CLI. If you adopt #3018 first, publish 0.5.0 once instead.
- **External pins:** anything that pins the SDK through `pkg.pr.new` breaks on #2953's renames and #3004's flatten. The codemod is in #3004's body, under "Re-running the codemod".

### Dashboards and external reports

- **PostHog dashboards 839068 and 839069** still chart the old per-test CI events. Rebuild them on `ci workflow run finished` and `ci job attempt finished` (#2962). Suggested tiles: p50/p90 run duration per workflow, first-attempt success rate per job, and queue time.
- **Send the Cloudflare report** in [#3011](https://github.com/iterate/iterate/pull/3011)'s body, under "For Cloudflare". It covers Durable Object calls failing with `internal error` for 5–40 s on a brand-new Worker Preview, then intermittently for minutes, with a repro and reference ids. Add the undeletable Artifacts namespace from above.
- **Parquet test results** ([#2984](https://github.com/iterate/iterate/pull/2984), draft): create the R2 bucket `ci-test-results` with a 365-day lifecycle rule, create a token scoped to that bucket, put its keys in Doppler `_shared/preview` as `TEST_RESULTS_R2_ACCESS_KEY_ID` and `TEST_RESULTS_R2_SECRET_ACCESS_KEY`, then set `TEST_RESULTS_PARQUET: upload` in `test.yml` and `preview-os.yml`.

## Proposals with implementation

### The merge queue (this PR)

**The problem.** A PR's checks prove the PR merged into main as main stood at its last push; #3014 made all three checks test that merge commit. Two PRs that are each green can still break main together. Since 2026-09-22 12:00 UTC, 7 of 199 commits on main failed a required check. The costliest cases:

- #2900 × #2888: Lint was red on main for 11 minutes, and Deploy Dash shipped a `ReferenceError` to the prd dash.
- #2904 × #2920: Test was red for 18 minutes, and five PR runs failed on the red base.
- #2935 (00:16 UTC today): its branch commits predated the lint cutoff and its squash commit did not. That class is gone with #2998.

Since midnight UTC today 86 PRs merged, most of them from agents working in parallel, which is when this happens most.

**How it works.** When a PR is queued, GitHub builds `gh-readonly-queue/main/pr-<n>-<sha>`: main, every PR ahead of it, and this PR. The required checks then run on that commit, and the PR merges only if they pass. For example, suppose PR A renames `touchesPreview` to `matchesPreviewPaths`, and PR B adds a call to `touchesPreview`. Each is green on its own, so today both merge and main's Typecheck goes red. With the queue, A merges; B's group (main + A + B) fails Typecheck; B leaves the queue with a timeline entry naming the failed check; main stays green.

**What this PR changes:**

| File                                                                                                                        | Change                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`.depot/workflows/lint-typecheck.yml`](../.depot/workflows/lint-typecheck.yml), [`test.yml`](../.depot/workflows/test.yml) | `merge_group: {}` added. They already check out `github.sha`, which is the group's commit in a queue run, and their concurrency groups key on `ref_name`, which is each group's own branch.                                              |
| [`.depot/workflows/preview-os.yml`](../.depot/workflows/preview-os.yml)                                                     | No `paths` filter; `merge_group: {}` added. A new `changes` job matches the merge commit's changed files against the preview paths, and deploy and e2e run only on a match. A new `gate` job always runs last: **Preview OS / gate**.    |
| [`scripts/ci/preview-os-gate.ts`](../scripts/ci/preview-os-gate.ts) and its test                                            | `previewPaths` (the list the `paths` filter held), `touchesPreview` (GitHub's `paths` semantics) and `previewVerdict` (the gate's rules). 27 table rows, including real merge commits in a scratch repo (a rename counts on both sides). |
| `preview-delete.yml`, `depot-workflows.test.ts`, `main-os-e2e-workflow.test.ts`, `preview-os-workflow.test.ts`              | The delete and main's e2e keep the same path list, checked against `previewPaths`. New tests: every requirable workflow runs on `merge_group` and has no `paths` filter; the deploy and gate conditions, table-tested.                   |
| [`docs/depot-ci.md#merge-queue`](depot-ci.md#merge-queue), [`docs/pull-requests.md`](pull-requests.md)                      | How the queue and the gate work, what `gh pr merge` does once main requires the queue, and the Depot CLI's token. Editing `pull-requests.md` changes the PR guidance hash when this merges, which is intended.                           |

**Why a gate job.** GitHub leaves a required check "Pending" forever when a `paths` filter skips its workflow. It also counts a job skipped by its own `if` as passing, so requiring `Preview OS / e2e` would let a failed deploy through: e2e would be skipped, and skipped counts as green ([GitHub docs](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks#handling-skipped-but-required-checks)). The gate always runs and decides:

| Event       | changes                 | deploy, e2e                         | Gate                                                                                                                    |
| ----------- | ----------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| PR          | no preview path touched | skipped                             | green: nothing to prove (docs, lint rules, Kit firmware)                                                                |
| PR          | preview path touched    | both succeeded                      | green                                                                                                                   |
| PR          | preview path touched    | either failed, cancelled or skipped | red                                                                                                                     |
| PR          | failed                  | skipped                             | red: nothing decided whether to deploy                                                                                  |
| merge group | skipped                 | skipped                             | green: the PR's own gate was green before it joined the queue, and Lint and Test run again on the group                 |
| dispatch    | skipped                 | e2e succeeded                       | green                                                                                                                   |
| dispatch    | skipped                 | anything else, or no PR number      | red. A dispatch posts on the dispatched ref's head, where it counts for that PR, so it never goes green without an e2e. |

Evidence so far: on this PR, `changes` ran and matched (the PR edits `preview-os.yml`), deploy and e2e ran behind it and passed, and the gate went green after them. A branch dispatch with no PR number ran the gate behind three skipped jobs (Depot run `vngc26m2mx`). That dispatch passed under the first version of the rule, and showed that a dispatch's green gate lands on the PR's head. The dispatch rule above is the fix. The `merge_group` path cannot run before this is on main, because Depot registers triggers from the default branch; the trial below covers it.

**Phases.**

1. **Queue with Lint and Typecheck and Test** (recommended now). Queue latency is one Test run: 3–3.5 minutes on main today (Lint takes 25–50 s), plus runner start. With a build concurrency of 5, the queue merges up to about 60 PRs an hour.
2. **Add `Preview OS / gate`** once the Preview OS e2e job passes about 98% of the time (about 93% in calm hours today). The PR's own gate then has to be green before the PR can join the queue. In the queue, the gate passes without redeploying.
3. **Optional later: e2e on the group itself.** Deploy a preview of the group commit and run e2e in the queue. That catches semantic conflicts that only the deployed platform shows, but it adds about 8 minutes per group and needs preview names for groups. It is not built.

**The ruleset** (phase 1; for phase 2, add `{ "context": "Preview OS / gate" }` to the list):

```bash
gh api repos/iterate/iterate/rulesets/18718115 > required-ci-before.json   # the rollback copy
cat > required-ci-merge-queue.json <<'JSON'
{
  "name": "Required CI",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "bypass_actors": [],
  "rules": [
    {
      "type": "required_status_checks",
      "parameters": {
        "do_not_enforce_on_create": false,
        "strict_required_status_checks_policy": false,
        "required_status_checks": [
          { "context": "Lint and Typecheck / lint-typecheck" },
          { "context": "Test / test" }
        ]
      }
    },
    {
      "type": "merge_queue",
      "parameters": {
        "merge_method": "SQUASH",
        "grouping_strategy": "ALLGREEN",
        "max_entries_to_build": 5,
        "max_entries_to_merge": 5,
        "min_entries_to_merge": 1,
        "min_entries_to_merge_wait_minutes": 5,
        "check_response_timeout_minutes": 30
      }
    }
  ]
}
JSON
gh api -X PUT repos/iterate/iterate/rulesets/18718115 --input required-ci-merge-queue.json

# rollback
jq '{name, target, enforcement, conditions, bypass_actors, rules}' required-ci-before.json |
  gh api -X PUT repos/iterate/iterate/rulesets/18718115 --input -
```

The settings, with reasons:

- **`SQUASH`:** each PR stays one commit with its title and body, as now (`squash_merge_commit_title: PR_TITLE`).
- **`ALLGREEN`:** every PR's own group must pass. `HEADGREEN` would merge a PR whose group failed whenever a later group passed, which hides flakes; Test's first try is about 99%, so it isn't needed.
- **Timeout of 30 minutes:** Lint's and Test's job timeouts are 20.
- **No bypass actors**, as today. In an outage, run the rollback instead.

While you are in the rulesets: the older "Protect Main" ruleset (id 8296699: no force push, no deletion, PR required, squash only) is disabled.

**The trial, before touching main** (after this PR merges, so Depot has registered the `merge_group` triggers):

```bash
# 1. A scratch branch with its own queue
git fetch origin && git push origin origin/main:refs/heads/merge-queue-trial
jq '.name = "Merge queue trial" | .conditions.ref_name.include = ["refs/heads/merge-queue-trial"]
    | .rules[0].parameters.required_status_checks += [{ "context": "Preview OS / gate" }]' \
  required-ci-merge-queue.json | gh api -X POST repos/iterate/iterate/rulesets --input - --jq .id

# 2. Two PRs, each green alone, broken together
git switch -c mq-trial-a origin/merge-queue-trial
sed -i 's/touchesPreview/matchesPreviewPaths/g' scripts/ci/preview-os-gate.ts scripts/ci/preview-os-gate.test.ts
git commit -qam "merge-queue trial A: rename touchesPreview" && git push -u origin mq-trial-a
gh pr create --base merge-queue-trial --title "merge-queue trial A" --body "Throwaway."
git switch -c mq-trial-b origin/merge-queue-trial
printf '\ntest("merge-queue trial B", () => {\n  expect(touchesPreview(["apps/os/x.ts"])).toBe(true);\n});\n' \
  >> scripts/ci/preview-os-gate.test.ts
git commit -qam "merge-queue trial B: call touchesPreview" && git push -u origin mq-trial-b
gh pr create --base merge-queue-trial --title "merge-queue trial B" --body "Throwaway."

# 3. When both PRs are green (each gets a green changes and gate, with no preview), queue A, then B
gh pr merge <A>; gh pr merge <B>

# 4. What to check, once A has merged: the queue pushes A's group commit itself, so the trial
#    branch's head carries the checks that ran in the queue
gh api "repos/iterate/iterate/commits/merge-queue-trial/check-runs" --jq '.check_runs[] | "\(.name) \(.conclusion)"'
gh api graphql -f query='{ repository(owner: "iterate", name: "iterate") { pullRequest(number: <B>) {
  state timelineItems(last: 5, itemTypes: [REMOVED_FROM_MERGE_QUEUE_EVENT]) {
    nodes { ... on RemovedFromMergeQueueEvent { reason createdAt } } } } } }'
```

What should happen:

- Depot runs Lint and Typecheck, Test and Preview OS on each `gh-readonly-queue/merge-queue-trial/pr-<n>-…` branch.
- The check names equal the required contexts **exactly**. This is the main thing to verify; a mismatch would make the queue wait 30 minutes and then drop the PR.
- The gate says "merge group".
- A merges. B's group fails Typecheck (`touchesPreview` no longer exists), and B leaves the queue with a timeline entry naming the check.

Then clean up: delete the trial ruleset (`gh api -X DELETE repos/iterate/iterate/rulesets/<id>`), close B, and delete `merge-queue-trial`, `mq-trial-a` and `mq-trial-b`. Then apply the ruleset to main.

**What changes for people and agents once it's on:**

- `gh pr merge <n>` queues instead of merging ("will be added to the merge queue"), and returns at once. Agents wait for `gh pr view <n> --json state` to say `MERGED`; `docs/pull-requests.md` says so in this PR.
- The merge captain's rule of "merge anyway when only performance rows fail" no longer applies to required checks. The performance budgets already run in their own suite (#2977), so e2e has none.
- Main still deploys on each push. The queue pushes once per merged group, so up to 5 PRs can arrive in one push and one deploy.

### Other open proposal PRs

- [#3018](https://github.com/iterate/iterate/pull/3018), the SDK/platform line: [decision 5](#5-the-sdkplatform-line-3018). It conflicts with main since #3023.
- [#2984](https://github.com/iterate/iterate/pull/2984) (draft), per-test results as Parquet in R2: off until the bucket and token exist ([Dashboards and external reports](#dashboards-and-external-reports)).
- #2982 (grandfather baseline): **superseded and closed.** #2998 deleted grandfathering instead.
- **In flight, landing on their own:** [#3010](https://github.com/iterate/iterate/pull/3010) (contexts re-arm an alarm Cloudflare held past its time, the late-deadline bug) and [#3027](https://github.com/iterate/iterate/pull/3027) (a sign-in whose code exchange times out returns to the sign-in page instead of a raw 500). Also in flight: stable preview names for main's runs, and the facet aborts that reset a whole Durable Object (the cause behind #3001).
- **Misha's older PRs, untouched:** #2553 (script provenance), and the drafts #2744, #2751 and #2775.

## Follow-ups

**OAuth, before and with the library's 1.0** (from the #2950 model check against `workers-oauth-provider`):

1. **One resource per grant before upgrading to 1.0.** 1.0 binds each grant and token to exactly one resource, and today some cover both `/api` and `/mcp`. Mint each personal token for one resource (`/api` by default, `/mcp` when asked), and give the admin credential the resource of the route it came in on. The upgrade is breaking, so pair it with a prd reset.
2. **Idle expiry for browser sessions once on 1.0:** `refreshTokenIdleTTL` of about 7 days, with `deadline` kept as the 30-day cap.
3. **Refresh the email at token refresh:** return `newProps` from `tokenExchangeCallback`. Low priority.

**CI and tooling:**

- **Depot re-run telemetry gap:** a re-run that starts more than 2 h after its workflow was created sends no PostHog event. Depot keeps the original creation time, and its listings cannot filter by update time (#2962).
- **`router.invalidate()` without `{ sync: true }`** in apps/agents and the dash's secrets and sessions pages. #3016 fixed it in voice, where a spec depended on it.
- The alarm workflows [`prd-fault-alarm.yml:25`](../.depot/workflows/prd-fault-alarm.yml#L25) and [`do-duration-probe.yml:59`](../.depot/workflows/do-duration-probe.yml#L59) still run on `depot-ubuntu-24.04`, with a `pnpm install` and `curl … | sh` for Doppler, about 120 times a day. Move them to the baked image.
- apps/os has no `routes:check` in `typecheck` ([`apps/os/package.json:10`](../apps/os/package.json#L10)).
- Four vitest versions (4.0.15 in three packages, and `^4.1.5` through `^4.1.10`), and zod as exactly `4.5.4` in some packages and `^4.1.5` in others, although `patches/zod@4.5.4.patch` applies only to 4.5.4. A pnpm catalog would fix both.
- Lint config: `import/extensions` and `iterate/relative-import-extensions` report the same thing ([`.oxlintrc.json:108`](../.oxlintrc.json#L108), :169). `isolated-codemode`, `unicorn-js/isolated-functions` and `codegen/codegen` are armed with nothing to check (:122, :134, :175). knip does not use `includeEntryExports` for packages/shared and packages/ui.
- Kit firmware CI: the host build fetches capnweb with `GIT_SHALLOW FALSE` ([`apps/kit/firmware/CMakeLists.txt:28`](../apps/kit/firmware/CMakeLists.txt#L28)), and nothing on the server reads the `X-Iterate-Fw` header the board sends.
- `middlewright` is pinned to a pkg.pr.new build ([`package.json:40`](../package.json#L40)); publish 0.1.7 from `e3f2374` and pin that.

**Code, each verified on main today** (P2 is worth scheduling; P3 is for when you are working in that area):

| Item                                                                                                                                                                                                                                                              | Where                                                                                                                                                                          | Pri |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --- |
| The rest of A1: scheduled-append firing and the fetch path still live in the context DO (1,205 lines)                                                                                                                                                             | [`iterate-context-durable-object.ts`](../apps/os/src/iterate-context-durable-object.ts)                                                                                        | P2  |
| The agent UI reducer still reads the legacy `capability-host/script-run-*` vocabulary, and apps/agents translates into it                                                                                                                                         | [`agent-events.ts:55`](../apps/agents/src/lib/agent-events.ts#L55), `packages/ui/src/components/events/agent-ui-reducer.ts` (1,126 lines)                                      | P2  |
| The control plane's edge calls are string-dispatched: `#call<T>(method: string, …)`                                                                                                                                                                               | [`control-plane/edge.ts:67`](../apps/os/src/control-plane/edge.ts#L67)                                                                                                         | P2  |
| Voice runs a second agent loop, with 24 script steps and `user` feedback                                                                                                                                                                                          | [`apps/agents/voice/delegation-turn.ts:13`](../apps/agents/voice/delegation-turn.ts#L13)                                                                                       | P3  |
| `append` echoes the whole committed batch back, which can exceed the 32 MiB RPC cap, and a retry duplicates it. Receipts (`{ offset, createdAt }`) would be an API change                                                                                         | [`memory-budget.test.ts:143`](../apps/os/src/stream/memory-budget.test.ts#L143) (pinned), and the two OOM pins at :383 and :398                                                | P2  |
| The loader's new-generation heal logs no `platform-failure` warn                                                                                                                                                                                                  | [`context/worker-loader.ts:207-216`](../apps/os/src/context/worker-loader.ts#L207-L216)                                                                                        | P2  |
| The self-loop hop budget gap is an opt-in probe that nothing runs                                                                                                                                                                                                 | [`ingress-project-host.e2e.test.ts:225`](../apps/os/e2e/ingress-project-host.e2e.test.ts#L225)                                                                                 | P2  |
| `erase-data` empties R2 with a bulk `DELETE …/objects` that only its own mock backs                                                                                                                                                                               | [`apps/os/scripts/erase-data.ts:95-97`](../apps/os/scripts/erase-data.ts#L95-L97)                                                                                              | P2  |
| The e2e harness is untyped (19 `any` in `client.ts`), and there are two `until`s with different semantics                                                                                                                                                         | `apps/os/e2e/support/client.ts`, `apps/os/__workers-tests__/support.ts`                                                                                                        | P2  |
| Dash and Agents have no Playwright project (`os`, `os-phone`, `notes`, `voice`, `suite`)                                                                                                                                                                          | [`playwright.config.ts:76-100`](../playwright.config.ts#L76-L100)                                                                                                              | P2  |
| The flake dashboard's fold still carries the legacy stream design ("the legacy `/flakes` stream offsets, continued")                                                                                                                                              | [`scripts/ci/flake-dashboard/update.ts:52`](../scripts/ci/flake-dashboard/update.ts#L52)                                                                                       | P3  |
| `do-reset` still parks legacy migrations and container classes, which its only caller doesn't have                                                                                                                                                                | [`scripts/lib/do-reset.ts:366`](../scripts/lib/do-reset.ts#L366), `erase-data.ts:197`                                                                                          | P3  |
| Persisted leftovers: the `AgentDurableObject` tombstone, the `kit/voice/` KV prefix, Kit's `/.auth/login` redirect for "old bookmarks", notes treating `creation: null` as ready, the stream's "store from before the SQL layout", the hand-narrowed `APP_CONFIG` | `wrangler.base.jsonc:92`, `voice/install.ts:5,53`, `kit/src/device-auth.ts:73`, `notes/…/projects.$slug.tsx:145`, `stream/stream.ts:150`, `app-config.ts:232`                  | P3  |
| The repo's `readModules` and the workspace mount's `{ repo }` (public API, which is why #3021 left them)                                                                                                                                                          | [`repo/durable-object.ts:80`](../apps/os/src/repo/durable-object.ts#L80)                                                                                                       | P3  |
| Names: `DEMO_BASE_URL` beside `WORKER_BASE_URL`; `APP_CONFIG_ADMIN_API_SECRET` for the admin bearer; the MCP server calls itself `control-plane`; `KitEnv` and `DummyPetshopEnv` are one shape                                                                    | `docs/dev-environments.md`, `.agents/skills/*`, [`mcp.ts:102`](../apps/os/src/mcp.ts#L102), [`envs.ts:43`](../envs.ts#L43), :289                                               | P3  |
| PostHog is three integrations: packages/ui, the issuer's inline `posthog-js`, and `posthog-node`                                                                                                                                                                  | [`apps/os/src/routes/__root.tsx:31`](../apps/os/src/routes/__root.tsx#L31)                                                                                                     | P3  |
| Structure: 3 first-party facet tables, `/not found\|10200/` Artifacts detection, a 1,245-line `preview.ts`, 22 `"use client"` in packages/ui                                                                                                                      | `first-party-facet-placement.ts:44`, [`cf-artifacts.ts:133`](../apps/os/src/context/cf-artifacts.ts#L133), `apps/os/scripts/preview.ts`                                        | P3  |
| Dead code: `SourceCodeBlock`'s editing props, the presence demo processor in `src/`, `deployApp`'s `afterDeploy`, Kit's `micDropped`/`spkDrops` counters and the Python config-image encoder                                                                      | `source-code-block.client.tsx:30-39`, `apps/os/src/client/presence/`, `scripts/lib/deploy-app.ts:66`, `voice_loop.c:1949,2024`, `apps/kit/firmware/tools/make-config-image.py` | P3  |
