# Architectural preview — 5 September 2026

URL: https://iterate-project-core-experiment-preview.iterate-dev-preview.workers.dev

This is a new experiment Worker in the dev/preview account
`376ef7ed81b0573f93524de763666c15`. Its exact name was verified absent before
creation. Its OAuth KV namespace `c4ba23e6d2a44c6fad3f3c9d498457c1` was also
created for this experiment. No existing product, other experiment, Access
policy, route or Doppler configuration was overwritten.

This file retains that **dev-account deployment's** history. The newer,
separate domain stack at `https://iterate2.com` is live; its version, full
43-test run and trace audit are in [domain-preview.md](domain-preview.md).
Its custom apex/wildcard proof is in [hostname-ingress.md](hostname-ingress.md).

## Identity and authority

- `/login` accepts any syntactically valid email, without ownership verification.
- Browser projects are shared sandbox state, not private accounts/membership.
- Opaque browser sessions are stored in KV for 24 hours. The cookie is
  HttpOnly/SameSite=Lax and Secure on HTTPS; it is stripped before core routing.
- `@cloudflare/workers-oauth-provider@0.10.3` supplies discovery, registration,
  authorization-code/PKCE and token handling for `/mcp`. Consent selects one
  project; another project is denied. Demo login is not an event signature.
- Secret writes use a separate deployment-admin credential. The initial
  encryption key and admin credential were cryptographically generated in
  memory, sent on stdin, and neither printed nor written to a local file.
- This is not production multi-tenant authentication. KV session consistency,
  same-origin app isolation, membership and account recovery are not claimed.

## Current candidate — deployment only

Version **`6e72d24a-caad-49a4-aedf-1b187fd639cc`** deployed between
**11:42:16.224 and 11:42:31.134 UTC** on 5 September 2026. Upload size was
**892.49 KiB** (**157.55 KiB gzip**) and startup was **27 ms**. It contains the
routing and native-WebSocket candidate.

The focused public run from **11:42:58.632 to 11:43:13.991 UTC** passed **2/2**
in **15,331.430125 ms**. The non-hostname full public suite from **11:44:04.142
to 11:45:17.823 UTC** passed **42/42**, with no retries or skips, in
**73,644.275334 ms**.

For only WebSocket upgrades, both `routeFetch()` and `FetchDestination` choose
private fresh source loading (`cache: false`), so a live connection does not
reuse a cached dynamic worker. Ordinary HTTP/RPC source caching and the
independent build KV remain unchanged. This is a bounded experiment motivated
by probe `c3a1f50b`: direct named `.get()` and a held stub reproduce red,
while `.get(null)` is clean. It does not establish the native runtime cause.

The hostname-ingress source is also deployed, but the configured base is
`project-core.invalid`; no DNS or Worker route was written, so no hostname is
reachable and hostname acceptance has not run on preview.

The bounded full-run telemetry window, **11:44:00–11:45:20 UTC**, has zero
exception, hung, reset or never-response outcomes. Three `Hello.boom()`
Context errors are intentional fixture effects, paired with three outer `/api`
success records—not six separate failures. Of 131 `responseStreamDisconnected`
outcomes, 126 are intentional 63-reader teardowns counted at two layers; the
remaining five are explicit stream/socket closures. However, **218 cancelled**
outcomes remain unclassified (153 from `Host.jsrpc`). This candidate is not
accepted as clean operational evidence until that class is explained.

The later isolated production-account domain stack for `iterate2.com` and
`iterate.computer` is live and recorded separately above; it did not replace
this dev-account Worker.

## Previous preview — unresolved outcomes (historical)

Version **`3fb575ba-31c2-410a-8faf-802126770dd6`** deployed between
**11:09:56.740 and 11:10:08.419 UTC** on 5 September 2026. It predates the
local hostname-ingress slice: hostname routing has not been deployed and no
DNS record was written.

The full credentialed public suite ran from **11:10:08.685 to 11:11:17.224
UTC** and completed **42 total: 38 passed, 3 failed, 1 cancelled**, in
**68,219.849875 ms**. The cancelled case was the one-fetch WebSocket test at
its 30-second limit. The processor-retry append 500 is now classified: trace
[`8940e7bb65de504ae21291fa23c5fae4`](https://dash.cloudflare.com/376ef7ed81b0573f93524de763666c15/observability/traces/8940e7bb65de504ae21291fa23c5fae4)
shows the old DO version `5b14` reset while the front had version `3fb`; its
`POST /api` for `project-core-e2e-mtoa72ft-b3516d494f07` occurred at
11:10:12.560/.561 UTC with `Durable Object reset because its code was updated.`

The two approval-pending 500s remain unexplained, not resets. In bounded
`cloudflare-workers` telemetry from 11:10:11.8–12.8 UTC (service filter,
trace-prefix needle, limit ≤200), traces
[`40222f1faa3b5251626ffdd3052cae21`](https://dash.cloudflare.com/376ef7ed81b0573f93524de763666c15/observability/traces/40222f1faa3b5251626ffdd3052cae21)
at 11:10:11.958 and
[`7d58b3574371ef3b56da73fd49b3a6c3`](https://dash.cloudflare.com/376ef7ed81b0573f93524de763666c15/observability/traces/7d58b3574371ef3b56da73fd49b3a6c3)
at 11:10:12.556 show an old-version `readFetchPolicy` outcome `ok`, then a
new-front 500 with only a `routeFetch` stack and no native message.

A later focused one-fetch/fault run passed **2/2**, and a separate run of the
three failed cases passed **3/3**. Those later successes do not explain the
original failures, so they do not make the full run green. Native WebSocket
exceptions also persist; focused trace
[`c2d8c6b3b54d30520dc756c8b2974f84`](https://dash.cloudflare.com/376ef7ed81b0573f93524de763666c15/observability/traces/c2d8c6b3b54d30520dc756c8b2974f84)
is retained for diagnosis. A newer clean-control probe,
`0a067056-9348-4373-8118-b677fe078d81`, narrows possible causes but is not a
core fix. This version's operational evidence is **not accepted as clean**.

The latest completed local suite, including the final hostname protocol
equality removal, passed **43/43**, zero skips, in **22,570.254 ms**. It
predates two extra custom-host cases, which subsequently passed in the
expanded hostname test (64.334 ms, 187.106833 ms total). Neither local change
is represented as a deployed result; see [hostname-ingress.md](hostname-ingress.md).

## Historical first deployed version

Version `0a42006d-9952-4d09-ab6f-002caf7357f5` uploaded successfully; startup was
27 ms and the bundle was 887.71 KiB / 155.60 KiB gzip. Native SQLite `Context`
creation and Worker Loader were accepted by Cloudflare.

The immediate full test run failed: 13 passed, 15 failed, one cancelled; the
egress test file failed during login setup, so its seven cases did not run.
Observed symptoms included one login 404, an anonymous API 500, HTML returned
to JSON callers, failed WebSocket upgrades, front-door/MCP exceptions and one
stream timeout. These are not classified as expected application outcomes.

A bounded query of this Worker only, 07:35–07:42 UTC, found nine error-tagged
rows: four front-door exception logs, their four HTTP 500 invocation rows, and
one MCP exception log. The available exception text contained only native
call-site stacks, so it did not establish the underlying cause. Example trace:
`f08a2fc21b274c96257a463a855b3d15`. Deployment propagation is a hypothesis, not
a proven explanation; no retry/fallback was added to the application.

Without changing the deployed version, the login test then passed, and a run
of core/lending/MCP/processors/provenance passed **27/27** in 30,013 ms with no
skips. A separate isolated browser session passed email login, identity display,
tutorial disclosure, append, replay, live follow, a live append and clean
follow shutdown, with no console errors. These later passes do not erase the
first failed run.

## Previous local checkpoint — native-input loading

The native-input loader slice now counts **4,996 raw authored lines**. Its
final full local HTTP/WebSocket suite passes **36/36**, no skips/cancellations,
in 21,095 ms. Type checking, formatting, and lint pass. Existing test cases and
expectations remain; shared fixtures offset the new loader contract and test.
No executable code was moved into excluded Markdown. See
[native-loader.md](native-loader.md) for the actual input/facade/confinement
proof. At this checkpoint the builder/cache layer was still proposed.

## Previous deployed version (before native-input loading)

Version `1c1f9daa-9af3-4151-b06f-cd5d55c396a8` deployed successfully with
27 ms startup and an 886.09 KiB / 155.51 KiB gzip upload. The test controller
rotated only this experiment's admin token in memory; the existing encryption
key was preserved. This version predates the direct `Scope.load()` slice.

The credentialed full remote suite passed **34/35**, no skips/cancellations,
in 50,688 ms. All seven secret/approval cases passed. The first lending case
failed in 7,219 ms with `NO_METHOD: No capability provides greeting.greet`.
Its Durable Object ID was
`91359d6a1e59749985fa22c19eaadfea3da6e3b2ef7d8cf1644f970129f2d35d`.
The exact failing call was not captured. Its duration suggests the post-idle
call, but that remains an inference, not a diagnosed cause.

A bounded replay on this same verified version passed both lending cases,
then three separately observed runs of the first case passed. Source inspection
shows normal idle release does not delete a mount; a pager detachment does.
No evidence yet proves why the original run lost the mount. No retry, fallback,
test weakening or speculative runtime fix was added. These successful replays
do not turn the failed full run into a green acceptance result.

A fresh isolated browser walkthrough on this version passed email login,
identity display, all eight tutorial disclosures, unsigned and signed append,
full provenance disclosure, replay, live follow and stop-follow. Browser error
logs stayed empty. Tutorial source references are checkout filenames rendered
as code text, not clickable source links.

## Previous deployed version — native-input loading

Version **`8ad69b0c-64a4-47dc-a9fb-61b62305144c`** deployed between
08:48:16 and 08:48:33 UTC; `/version` independently confirmed it afterwards.
Only the existing experiment Worker was updated, with `--keep-vars` and an
additive stdin secrets file containing a freshly generated admin credential.
The encryption key and OAuth namespace were preserved. No credential was
printed or written to disk.

An immediately preceding upload of the same source produced
`bb23e0d7-dc61-4e85-aeed-62ff5be0d5f1`. Its controller lost its in-memory admin
credential after a shell-variable error, so only this experiment's admin token
was rotated in the second upload. Later attempted background controllers were
terminated before Wrangler launched; they did not create another version.

The credentialed 36-test remote process ran and exited, but the execution
wrapper lost terminal output. Only the first eight core cases were captured
green. There is no trustworthy full-suite exit code or summary, so this run
is **unconfirmed**, not a pass. A later attempted core/lending capture also
lacked a terminal result. Neither is counted as acceptance.

A directly supervised, focused run on the same version then passed **2/2**,
zero failures/skips/cancellations, in **2,683 ms**, completing at 08:54:33 UTC:

```sh
WORKER_BASE_URL=https://iterate-project-core-experiment-preview.iterate-dev-preview.workers.dev \
  pnpm --dir packages/v3/project-core exec node --test \
  --test-name-pattern='loads native-shaped|blocks fetch-gate' e2e/core.test.ts
```

This proves the new native input/facade and the single fetch-policy boundary
on Cloudflare. It does not replace the full suite or explain the old lending
failure on the previous version.

### Runtime observations

The Cloudflare general API telemetry query used account
`376ef7ed81b0573f93524de763666c15`, dataset `cloudflare-workers`, and both filters:

```ts
filters: [
  {
    key: "$metadata.service",
    operation: "eq",
    type: "string",
    value: "iterate-project-core-experiment-preview",
  },
  {
    key: "$workers.scriptVersion.id",
    operation: "eq",
    type: "string",
    value: "8ad69b0c-64a4-47dc-a9fb-61b62305144c",
  },
];
```

For the exact focused-test window **08:54:20–08:54:40 UTC**, it returned
**36 informational rows, zero warnings and zero errors**.

The earlier audit from deployment at 08:48:33 UTC found 12 error-level rows:
six deliberate `Hello.boom()` fixture calls, each with its DO error log and
outer `/api` 500. Fifteen `processor delivery failed` warnings corresponded to
the deliberate broken/retrying processor fixtures. Those are real telemetry
rows, not a zero-error claim. A correlated fixture example is
[trace 43ea1597473d1d72814b63020da2e405](https://dash.cloudflare.com/376ef7ed81b0573f93524de763666c15/observability/traces/43ea1597473d1d72814b63020da2e405).
No matching hung/cancellation/uncaught/subscription-callback/NOSENTRY/alarm
diagnostic was found in that bounded query. This does not establish the
missing full-suite result or erase the earlier unexplained failures.

## Previous deployed version — optional bundling and KV cache

Core **`69ebb66d-2ad8-4c19-aad3-0981629c542f`** was independently confirmed by
`/version` at **09:17:08 UTC**. Upload: 888.15 KiB / 155.86 KiB gzip; startup:
26 ms. Only this experiment was updated, with `--keep-vars`; existing secrets
were preserved without reading, printing or rotating them.

A new RPC-only compiler Worker,
**`iterate-project-core-bundler-experiment-preview`**, runs version
**`9d8d36c3-08dc-4e20-bd7c-5c0c0489436e`**. Its exact name was verified absent
before creation, in the same dev/preview account. `workers_dev` and preview
URLs are disabled and it has no public routes or project capability binding.
Upload: 15,046.52 KiB / 3,912.34 KiB gzip; startup: 49 ms.

The exact KV title `iterate-project-core-build-cache-experiment-preview` was
also checked absent before creation. Its ID is
**`296ab88a0f4b414baa33cd4c8e4881fe`**. The core uses a service binding to the
compiler; the compiler stores successful inert code in this KV. No existing
product Worker, KV namespace, route or credential was replaced.

At that checkpoint local source counted **5,241 raw authored LOC**: the hard size guard
fails. Its full local public HTTP/WebSocket suite passes **38/38**, no
failures/skips/cancellations, in **31,450.744 ms**. The [build proof](builds.md)
records the two cache boundaries and remaining typecheck/activation gaps.

### Focused public-network result

Between **09:17:08 and approximately 09:17:14 UTC**, this directly supervised
command passed **4/4**, no failures/skips/cancellations, in **4,443.635 ms**:

```sh
WORKER_BASE_URL=https://iterate-project-core-experiment-preview.iterate-dev-preview.workers.dev \
  pnpm --dir packages/v3/project-core exec node --test \
  --test-name-pattern='bundles pinned|returns source diagnostics|loads native-shaped|blocks fetch-gate' \
  e2e/build.test.ts e2e/core.test.ts
```

Cases: bundle/cache/context authority (2,796.910 ms), rejected source
diagnostics (1,279.211 ms), native loader (691.961 ms), and fetch-gate confinement
(1,062.095 ms). Tests overlap, so durations do not sum to wall time.

A full remote 38-test run has **not** been performed on this version. The
matching deployment-admin credential is no longer in the current controller's
memory. Focused cases above need no admin credential; none was rotated merely
to run them. Earlier unexplained deployment/lending failures remain open.

### Telemetry: results received, cancellation classification still open

The bounded **09:17:00–09:17:30 UTC** query of these two exact services in
`cloudflare-workers` returned:

- Core: **61 informational rows, zero warnings/errors**.
- Compiler: **6 informational rows, 2 warnings, zero errors**. Both warnings
  are the upstream worker-bundler experimental-API advisory. All six compiler
  build invocations have native outcome `ok`.

However, informational does **not** imply a healthy native outcome. Core
invocations include **6 `build/canceled`, 7 `get/canceled`, and 7
`fetch/canceled`**. Build results and diagnostics reached the test client, and
the downstream compiler calls succeeded. That rules out treating the badges
alone as proof that compilation failed; it does not prove the cancellations
are all expected session teardown.

Example diagnostic-build trace:
[8939dfadd0bb49d91d7502925eaca8c3](https://dash.cloudflare.com/376ef7ed81b0573f93524de763666c15/observability/traces/8939dfadd0bb49d91d7502925eaca8c3).
Its canceled intermediate Context calls include request IDs
`1a366896cd982b6cbd999e91f48fe001`, `741ffd12dfc41eb5a809982a30fa31ab` and
`021f82dcbb5fda45c85f5840d6802934`.

Pinned workerd source assimilates returned RPC thenables and explicitly
distinguishes an incoming native call's cancellation from its JavaScript
promise. It also proactively closes a session once no capabilities remain.
Those mechanisms make result-forwarding/session teardown a plausible
explanation, but do not identify this trace's cancellation initiator.
[RPC return handling](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/src/workerd/api/worker-rpc.c%2B%2B#L1178-L1250),
[session completion](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/src/workerd/api/worker-rpc.c%2B%2B#L2210-L2252).

No speculative `async`/`await` change, telemetry suppression or automatic retry
was added. A correlated lifetime repro is still needed. **This window is not
accepted as clean operational evidence merely because error-level rows are
zero.**

## Current deployed version — one fetch policy

Core **`5b14ebe0-f704-4426-9c19-8fc97275a791`** deployed starting
**10:03:42 UTC**; `/version` independently confirmed it at **10:04:01.465 UTC**.
Upload: **890.96 KiB / 156.87 KiB gzip**, startup **40 ms**. This updates only
the existing experiment Worker. `--keep-vars` and an additive stdin secrets
file preserved the encryption key and existing bindings. Only its own admin
token was cryptographically rotated in memory for the credentialed test run;
no credential was printed, saved to a file, or written to Doppler. Compiler
version and all namespace IDs above are unchanged.

The single `mount/fetch` policy and static native `NEXT.to()` continuations
are now deployed. [one-fetch.md](one-fetch.md) records their exact interface,
local red/green proof, and limited network-terminal revocation guarantee.
Existing project settings using the previous split configuration are not
automatically migrated or erased.

### Full public-network result and corrected streaming fixture

The directly supervised credentialed full suite started at **10:04:01.465 UTC**
and returned a captured terminal result: **40 passed, 1 failed, zero skips or
cancellations**, **32,440.892 ms**. Every existing secret/approval test passed.
The new internal routing, denial, external approval and real WebSocket echo
case also passed.

The failing case held an incomplete chunked HTTP upload open from Node while
waiting for the policy's `entered` event. It failed with `fetch failed` caused
by `read ECONNRESET` in **15,722.171 ms**. One bounded unchanged replay failed
the same way in **15,559.946 ms**. The exact project's **10:04:00–10:04:40 UTC**
all-dataset search found **210** informational successful `/api` polling rows,
and no matching `/p/…/streaming` invocation. This bounds the observation to
before the policy was reached; it does not identify which upstream hop reset
the upload or establish a general Workers upload limitation.

Public `readEvents` for the original failed project
`project-core-streaming-policy-mto7tzaf-a5a41cd204a7` returned only the installed
`policy` event at offset 1, head 1: no `entered`, replacement, or egress event.

The retained fixture instead generates the delayed outbound stream inside the
loaded policy worker. Public HTTP installs it, observes `entered`, and replaces
the policy; the worker sees that event through Scope and closes the body. No
private hook or database inspection was added. A local negative control that
temporarily omits only the final freshness assertion fails with `202` instead
of `409` (42.513 ms). That assertion was restored immediately and never deployed
disabled. The corrected test passes on this **same preview version** in
**1,006.289 ms**, total **1,602.648 ms**. No production source change was needed
for the test transport correction. The incomplete public upload failure remains
recorded; the corrected test does not claim to fix that path.

The corrected full remote suite has **not** been rerun. Its matching admin
credential ended with the foreground controller; do not turn separate focused
passes into a claimed single green full run.

### UI proof

An isolated headless browser independently verified `/version`, fresh email
login, all eight tutorial disclosures, the seventh lesson's one-fetch code,
append/replay, live follow and stop. Browser console/page error logs remained
empty. The matching local walkthrough also passed. These are UI observations,
not a clean native runtime claim.

### Native telemetry remains an acceptance blocker

The general Cloudflare API query used the exact account/service/version above,
dataset `cloudflare-workers`, and four non-overlapping ten-second windows from
**10:04:00 through 10:04:39.999 UTC**. Each returned fewer than its 1,000-row
limit (636, 749, 353 and 421), for **2,159 rows**:

- **2,135 informational, 15 warning, 9 error** rows.
- Native outcomes: **1,752 `ok`, 257 `canceled`, 129
  `responseStreamDisconnected`, 3 `exception`**; 18 console rows have no native
  outcome. Informational rows are not automatically healthy.
- Fifteen warnings match the deliberate bounded poison/recovery processor
  fixtures (four sets of three poison attempts, three recovery attempts).
- Six error rows are the three deliberate `Hello.boom()` failures, each with
  its Context exception log and `/api` 500. Example
  [trace f7a7b6a5b931200b71949f37f33744a7](https://dash.cloudflare.com/376ef7ed81b0573f93524de763666c15/observability/traces/f7a7b6a5b931200b71949f37f33744a7).
- **Three exception rows are not explained**: they follow the successful
  WebSocket echo through static `FetchDestination`, Context and the public
  adapter. The telemetry exposes generic GET exception records, not a root
  exception message. See
  [outer/Context trace 79b09742b4357153c3af875363c95457](https://dash.cloudflare.com/376ef7ed81b0573f93524de763666c15/observability/traces/79b09742b4357153c3af875363c95457)
  and [destination trace a8dd1ef03fa4a7f87891ad26bf5ebd18](https://dash.cloudflare.com/376ef7ed81b0573f93524de763666c15/observability/traces/a8dd1ef03fa4a7f87891ad26bf5ebd18).

A focused WebSocket replay now awaits client shutdown and asserts close code 1000. It passes (**1,487.187 ms**, total **1,792.034 ms**) but the bounded
**10:12:10–10:12:30 UTC** query still finds native exception records. Thus simply
awaiting the client close did **not** remove the unexplained native outcome.
Example [trace 5031590f86e9a1afc22c0a17e0a0c4ea](https://dash.cloudflare.com/376ef7ed81b0573f93524de763666c15/observability/traces/5031590f86e9a1afc22c0a17e0a0c4ea).
The stronger close assertion is retained, without suppressing the telemetry.

Further isolated probes at **10:21–10:22 UTC** also reproduced the exception
chain after telemetry ingestion. Their early queries appeared empty; that was
premature evidence, **not** a clean control. For
`ws-full-mto8g3kp-80d8055455a2` (10:21:25.894–10:21:27.674 UTC), the client
echoed and closed with code 1000, while Context and the public socket request
recorded exceptions in
[trace 891e7cb16017f20db70314ac35150e34](https://dash.cloudflare.com/376ef7ed81b0573f93524de763666c15/observability/traces/891e7cb16017f20db70314ac35150e34).
For `ws-scope-after-mto8h7nh-0530bbc110bd` (10:22:06.719–10:22:07.457 UTC),
the same successful client observations accompanied all three exception legs:
[Context/public trace 26641032c95a248850ca02a99b70d382](https://dash.cloudflare.com/376ef7ed81b0573f93524de763666c15/observability/traces/26641032c95a248850ca02a99b70d382)
and [destination trace b01c17c0cb10247d39bdcd553ba3ae51](https://dash.cloudflare.com/376ef7ed81b0573f93524de763666c15/observability/traces/b01c17c0cb10247d39bdcd553ba3ae51).
The project-ID search also matches native child URLs (`https://<project>.iterate/socket`);
these are the available Workers event chains, not a complete OTel span tree.
Thus neither awaited client close nor full-suite concurrency explains the
failure. No server-close-listener change has been established as a fix. No
core change or deployment was made for these probes.

The compiler's same full-suite window contains six `ok` RPC invocations, two
upstream experimental-API warnings and no errors, all at its unchanged version.
The core's native cancellations/disconnections still need correlation by
session lifecycle; the counts alone do not establish expected teardown.

The bounded query is reproducible with:

```ts
await cloudflare.request({
  method: "POST",
  path: `/accounts/${accountId}/workers/observability/telemetry/query`,
  body: {
    queryId: "one-fetch-full-0",
    timeframe: {
      from: Date.parse("2026-09-05T10:04:00Z"),
      to: Date.parse("2026-09-05T10:04:09.999Z"),
    },
    view: "events",
    limit: 1000,
    parameters: {
      datasets: ["cloudflare-workers"],
      filters: [
        {
          key: "$metadata.service",
          operation: "eq",
          type: "string",
          value: "iterate-project-core-experiment-preview",
        },
        {
          key: "$workers.scriptVersion.id",
          operation: "eq",
          type: "string",
          value: "5b14ebe0-f704-4426-9c19-8fc97275a791",
        },
      ],
    },
  },
});
// Repeat for :10–:19.999, :20–:29.999 and :30–:39.999; group returned rows.
```

**This preview is not accepted as operationally clean.** Neither focused
success nor the passing browser walkthrough erases these native outcomes or
the historical failures above.

### Isolated WebSocket transport diagnosis

A separate, newly named Worker now reproduces the native exception without
project-core, OAuth, Cap'n Web, repository or policy code. It does not share
the core's bindings or change the core preview. The complete fixture, exact
telemetry query and deployed-version evidence live in
[project-core-ws-probe](../../project-core-ws-probe/README.md).

At probe version `0eaa843c-5e9e-49d9-b19a-b05cdb7c12a7`, all exchanges echoed
and closed with code 1000. After confirming telemetry ingestion, forwarding
an upgraded subrequest response through `DO.fetch()` still produced native
exceptions. Removing Worker Loader did not fix it: DO → static loopback →
direct socket also failed, with the diagnostic that an intermediate Worker's
code had hung and would never generate a response. A DO returning its own
socket remained clean in the preceding controls.

The same-run candidate kept the DO as configuration owner, read inert source
over Workers RPC, then loaded and returned the upgrade from the stateless
Worker. Its public-fetch and `ProbeContext.jsrpc` records were both `ok`
([trace b3e6ce8466279d8235f2fe50115232f1](https://dash.cloudflare.com/376ef7ed81b0573f93524de763666c15/observability/traces/b3e6ce8466279d8235f2fe50115232f1)):

```ts
// Isolated transport experiment, not yet the core's routing implementation.
const { source } = await env.PROBE.getByName("comparison").loaderPolicy();
return env.LOADER.load({
  compatibilityDate: "2026-09-01",
  mainModule: "echo.js",
  modules: { "echo.js": source },
})
  .getEntrypoint()
  .fetch(request);
```

The local workerd checkout at `c4e03fa1d2a3f2607e2b79567076d5fdd5179d03`
explains why the diagnostic is significant (the public blob lookup returned
404 in this session, so these links point to the inspected local source):
[`PendingEvent` teardown](/Users/jonastemplestein/src/github.com/cloudflare/workerd/src/workerd/io/io-context.c++:723)
schedules non-actor hang detection when no future event remains; the
[abort site](/Users/jonastemplestein/src/github.com/cloudflare/workerd/src/workerd/io/io-context.c++:1583)
emits the observed message. Locally terminating and proxy-through sockets
have different [pump lifetime handling](/Users/jonastemplestein/src/github.com/cloudflare/workerd/src/workerd/api/web-socket.c++:563).
An intermediate response-pump lifetime failure is therefore a source-informed
explanation consistent with the controls, not a claim of a confirmed upstream
patch or an excuse to reclassify the existing core exceptions as normal.

**The core routing repair is not applied yet.** It should preserve one fetch
policy, context-owned state and authority, while moving upgrade transport out
of `Context.fetch()`. The independent success does not yet prove the complete
policy → destination → application chain or classify the full suite's other
cancellation/disconnection outcomes.
