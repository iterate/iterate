# V4 preview evidence and unresolved release gates

This records observed versions separately; it is not release acceptance.
The initial observability baseline below remains relevant negative evidence.
Later versions have successful application-path and resource proofs. The accepted
15,000-line landing budget is met. Known inherited defects and unresolved
deployed failures are not presented as working behavior.

**Current scope (owner clarification, 6 September): deployed behavior only.**
Wrangler/Miniflare diagnostics below are parked historical tooling findings,
not acceptance blockers. No local-runtime repair is required for this landing.
The active gates are the deployed API/application paths, resource behavior,
durable state, and coherent deployed telemetry.

## Thirteenth deployment: durable cutoff for passive alarm wakes

Main `0b689aaa-a7ce-4b3e-af9a-44eebc9730ee`, bundler
`923b4a97-41de-4ae7-8748-c2be9cabaf9e`. The deployment API records main
creation at **09:09:28.948133 UTC on 6 September 2026**, at 100%; `/version`
passed. The complete local unit/Workers lane passed **463 ordinary tests plus
six inherited expected failures in 43 files**, all four typechecks passed, and
scoped lint was clean. The conservative implementation count is **14,814 lines**
(13,727 package + 639 shared environment map + 448 dependency patch).

The stateless cursor idle regression was red on version twelve: durable
configuration in `prj_cold-alarm-cursor-idle_mtpl145u_0` survived session
disposal, but grew from **one wake at 09:01:17.434 UTC to seven at
09:03:22.997 UTC**, exceeding the bound of three. An earlier fixture used
session-owned `provide`/`subscribe` leases and removed itself on disposal; its
delivery timeout is a test setup error, not evidence of this alarm loop.

Version thirteen persists the last activated **durable** head across
incarnations. Constructor wake facts remain durable but do not advance this
cutoff. Alarms finish older due cursor work without repeatedly delivering
their own wakes; a real public door activates the head and releases deferred
delivery. This also works when a target calls a sibling context instead of
looping back into its owner. The cutoff is clamped to the durable head, not
ephemeral offsets. A capped in-memory push preserves its undelivered ephemeral
tail. Two focused mutation checks were red when the cutoff and tail-preservation
fixes were individually removed; all five subscription-delivery unit tests
passed after restoration. No wake row is discarded or silently acknowledged.

The public matrix ran **09:10:19.205–09:11:11.467 UTC** and passed **85/85 in
19 files** with the deployment's admin credential available. It includes the
original 51 cases plus context/dotted calls, HTTP batch, session leases, live
provider teardown, HTTP and WebSocket fetch, facet pipelining, and Docs/Yjs
convergence and publication. No test retry was enabled.

Both independent idle checks passed. Hosted processor context
`prj_cold-alarm-idle_mtplcpom_0` grew from one wake at **09:10:18.647 UTC** to
three at **09:12:24.934 UTC** and retained its marker count. Durable stateless
cursor context `prj_cold-alarm-cursor-idle_mtplcqms_0` grew from one at
**09:10:19.936 UTC** to three at **09:12:26.704 UTC**; its sibling `/sink`
delivery count advanced from one to three after the public read. Its
subscription remained configured after all installer sessions closed.

The original no-retry resource matrix ran **09:12:02–09:13:54 UTC** and passed
**4/5**: byte-exact full read (5,739 ms), event-size refusal (6,126 ms), atomic
reply-size refusal (16,260 ms), and structural admission refusal (4,918 ms).
Catch-up failed in 3,955 ms, at **09:13:26.556 UTC**, with the exact classified
reset flags. All later refusal cases ran; this command did not use bail or retry.

The separate bounded caller-recovery proof passed on its first run against this
version (**09:14:26–09:15:53 UTC**). Its 24 writes each ran once, the full
144 MiB map was byte-exact, and only the known tally snapshot was repeated once
after the classified reset at **09:15:51.350 UTC**. The recovered snapshot had
count 24; the tail contained one configuration row. The exact telemetry window
has no error log or terminal native failure. Two info records at
**09:15:50.015 UTC** are the configured/deliver reports for that one interruption,
not two resets. Native OTel invocations all report `ok`: 104 DO calls, 51 ITX
calls, one DO alarm and five outer HTTP requests. Its 88 OTel
`span_not_ended` warnings are platform force-closed `storage_exec` (47) and
DO-subrequest (41) span records, not application error logs.
[Classified interruption trace](https://dash.cloudflare.com/04b3b57291ef2626c6a8daa9d47065a7/observability/traces/9157af7a90421c897d1445673641db7d).

**Remaining release gate: native WebSocket close telemetry.** The public
loaded-worker test explicitly observed 101, the correct echo and close code
1000, but its parent/DO trace recorded `exception`. A focused no-retry repeat
at **09:17:55–09:17:57 UTC** reproduced the successful socket exchange; live
Wrangler tail showed both native `exception` outcomes with **empty `exceptions`
and `logs` arrays**. An explicit server-side close acknowledgement at
**09:19:28–09:19:30 UTC** did not change the result and was reverted. This is
not evidence of a JavaScript throw; no global exception/cancellation allowance
has been added. The broader matrix also intentionally kills/disposes live
providers; its teardown outcomes must not be conflated with resource failures.
[Loaded WebSocket close trace](https://dash.cloudflare.com/04b3b57291ef2626c6a8daa9d47065a7/observability/traces/32abc32a8523ee999c173456cac25efb).

A final server error/close-listener diagnostic at **09:25:40–09:25:42 UTC**
again passed the client exchange and produced an empty-exception native error
outcome. No dynamic-worker listener record was visible in the owner's tail or
telemetry query; this does not prove the absence of an internal worker error.
All temporary fixture listeners and all owned tail processes were removed or
stopped. Main source and deployment remain version thirteen.

The source audit with Claude Fable identified a possible native double-report
path: [deferred proxy failure](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/src/workerd/io/worker-entrypoint.c%2B%2B#L528-L532)
can be rethrown and reported again; [the observer](https://github.com/cloudflare/workerd/blob/c4e03fa1d2a3f2607e2b79567076d5fdd5179d03/src/workerd/io/observer.c%2B%2B#L62-L71)
distinguishes deferred-proxy disconnects from other failures. This is a
source-backed hypothesis, **not identification of the deployed native exception**.
The September compatibility date already enables automatic close replies; no
WebSocket compatibility flag controls this proxy-pump outcome. Explaining the
remaining error requires the native failure category that customer telemetry
does not expose, or an explicitly approved acceptance exception. It is not
silently classified as a harmless close, and overall release acceptance is not
claimed.

The [focused WebSocket handoff](v4-native-websocket-close-repro.md) records the
reproduction command, distinct trace windows, reverted diagnostics and exact
native classification requested from Cloudflare. No support request has been
submitted.

## Twelfth deployment: classify platform interruptions and quiesce idle facets

Main `f982dda8-7f3c-41e7-80fb-e8a4b5ba60d6`, bundler
`16631b4e-6c8b-4fb9-bdf4-83edfeafc336`. The deployment API records main
creation at **08:47:02.74561 UTC on 6 September 2026**, at 100%; `/version`
passed. The complete local unit/Workers lane passed **460 ordinary tests plus
six inherited expected failures in 43 files** before deployment. All four
typechecks and scoped source lint passed. Implementation size is **14,766 lines**.

Native stub invalidation preserves healthy-stub ordering, clears a failed stub
only if it is still current, and rethrows the original failure without retry.
Only exact boolean `retryable: true`, `durableObjectReset: true`, and an absent
or false `overloaded` flag are logged as `expected_platform_interruption` at
info level. Unknown, malformed and overload errors remain error telemetry.
This follows Cloudflare's [exception and idempotent retry contract](https://developers.cloudflare.com/durable-objects/best-practices/error-handling/);
it does not infer a hidden host cause from an exception message.

Acceptance distinguishes the unchanged **no-retry diagnostic** below from a
separate **bounded caller-recovery proof**. The latter seeds each blob once,
reads every byte of the original 24 × 6 MiB log, enables the known pure tally
fixture once, and verifies its count and unique durable configuration. Across
all reads and that fixture's snapshot it permits at most one classified reset,
with visible operation/position/attempt metadata, a fresh public session and
a 250 ms delay. A second interruption, overload or unknown error fails. This
is not a general SDK retry policy: append, enablement and arbitrary facet calls
are never automatically replayed. No historical failed run is relabelled green.

The resource run at **08:57:01–08:58:32 UTC** seeded the original 24 × 6 MiB
fixture, completed its byte-exact full read, and returned tally count 24 without
using recovery. Its final test assertion used a mistyped subscription event
kind, so the whole test was red. A public tail read at
**08:59:56.802–08:59:57.199 UTC** independently confirmed exactly one canonical
`events.iterate.com/stream/subscription-configured` row at offset 28. The test
literal was corrected, not the durable state. The exact resource window has
**150 unique native invocations**, all `ok` (101 DO + 49 ITX, represented in
both telemetry datasets), zero warning/error logs, and zero
`expected_platform_interruption` events.

The hosted-facet idle regression was red on version eleven: between
**08:39:16.675 and 08:41:21.935 UTC**, context
`prj_cold-alarm-idle_mtpk8t7c_0` grew from one wake to four while all clients
were closed. On version twelve, **08:50:52.888–08:52:58.514 UTC**, context
`prj_cold-alarm-idle_mtpknkug_0` grew from one to three and the final snapshot
retained exactly one marker. Three permits the final cold alarm and final
public read; it does not permit recurring once-per-minute facet work. A
separate stateless-cursor idle path required version thirteen. The exact
version-twelve hosted-facet window has 19 unique native invocations (13 DO +
six ITX), all `ok`, with no warning/error log or classified platform interruption.
Service-wide background invocations are not attributed to the named test context.

## Eleventh deployment: discard failed native stubs, without retrying

Main `a70820ba-e97c-4077-9d59-30811d4cf72e`, bundler
`5b740550-9ac5-4ea9-9d5b-c372bf2ce091`; deployed at
**08:31:34.059917 UTC on 6 September**. The original no-retry resource run
started at **08:32:44 UTC**, seeded all 24 blobs once in
`prj_membudget_mtpk0g9x_0`, and passed its full read in 4,749 ms.
The subsequent snapshot failed in 4,329 ms, with failure metadata at
**08:34:08.923 UTC** explicitly recording `retryable: true`,
`durableObjectReset: true` and no overload flag. The three later refusal cases
were not run (`--retry=0 --bail=1`). This does not establish an OOM.

Trace `865a032ee11564f178802bf345611c31` contains the two subscription delivery
error records at **08:34:07.622 UTC**. In the 08:34:00–08:34:10 window all
119 OTel DO and 68 ITX entrypoint invocations reported `ok`; no OOM or canceled
outcome was found. The configured/deliver errors were not yet classified by
version eleven. The exact exception flags, rather than these native `ok`
outcomes or its text, establish the expected-interruption classification.
[Snapshot interruption trace](https://dash.cloudflare.com/04b3b57291ef2626c6a8daa9d47065a7/observability/traces/865a032ee11564f178802bf345611c31).

## Tenth deployment: dispose inert operation results; read-reset investigation

Main `41f21900-7cd6-4d5e-ac49-5141d0ddbdcc`, bundler
`cfd5e78a-e6e6-49f0-b60b-e2902c5c62a0`. The deployment API records main
creation at **23:41:41.30033 UTC on 5 September 2026**, at 100%; deployment-history
checks at approximately 23:51 UTC, **01:09 UTC**, and **07:27 UTC on 6 September** found no
subsequent upload.

This changes only the SDK's two known-inert stream operations: each still owns
the resolved context stub, and now also owns/disposes its original native
`append` or `readEvents` call promise after awaiting its plain-data payload.
Disposing only the resolved context stub was insufficient because the returned
page can retain a separate native result pipeline. Arbitrary/live-result API
ownership is unchanged. The [primary-source explanation](native-rpc-fetch-lifecycle-research.md)
records the distinction. Four typechecks, 15 focused local processor tests and
scoped source lint passed before deployment. The conservative implementation
count is **14,670 lines**, within the accepted 15,000-line budget.

The complete local unit/Workers lane on the unchanged version-ten source ran
on **6 September, 00:27:48.275–00:28:06.167 UTC**: 447 ordinary passes and six
inherited expected failures across 41 files. Its JSON report records 453 passed
because Vitest counts a correctly failing `test.fails` as passed; those six
cases remain known defects, not working behavior.

### Current API and publish controls

On **6 September**, the public matrix at **00:22:01.659–00:22:24.348 UTC**
passed 50 tests; its admin-secret egress test was skipped because that command
did not load the admin credential. Running that unchanged test separately with
the deployment's Doppler config at **00:23:26.528–00:23:28.613 UTC** passed.
Together these exercise all **51 cases**, including the new ten-cycle
finite-refusal→upgrade regression; this is not a claim that one run passed 51.

The six-session publish control, `56338388-4bfe-4fd6-94b3-51bfffce5c3f`, ran at
**00:23:04.053–00:23:12.956 UTC**. Every operation completed and every public
session was disposed. Its six API traces and nine native DO invocation spans
were `ok`, with no non-info row in the exact six-trace OTel query (208 rows).
Single-operation DO durations were 16 ms (head), 18 ms (commit), 1,025 ms
(check), 456 ms (build) and 1 ms (append); the combined publish's four spans
were 2,080, 1,912, 29 and 0 ms. The native zero is a recorded runtime duration,
not a claim of zero work. The service-wide worker-log query over
**00:23:03–00:23:14 UTC** also contained background alarms from earlier
contexts: 58 rows, all `ok`/info, not 58 control invocations.
[Combined publish trace](https://dash.cloudflare.com/04b3b57291ef2626c6a8daa9d47065a7/observability/traces/313e2627b14bad666b2dedde53d13155).

### Resource controls

The deployed-only run on **6 September, 07:27:47–07:29:13 UTC**, completed its
unchanged 24 × 6 MiB seed and byte-identical full read (5,838 ms). Processor
catch-up then failed (3,863 ms) with the code-update reset; `--retry=0 --bail=1`
left the three later refusal cases unrun. Trace
`33f5b5174606ca74f261d88346d0caca` records two error logs at **07:29:10.442 UTC**,
for configured catch-up and delivery of `user-tally`, on version ten. The native
outcomes are `ok`, not evidence that the application call succeeded. No OOM or
deployment change was observed in that interval.
[Catch-up failure](https://dash.cloudflare.com/04b3b57291ef2626c6a8daa9d47065a7/observability/traces/33f5b5174606ca74f261d88346d0caca).

Separate, operator-triggered public state reads found configuration at offset 28
and repeated `stream/woken` rows, with no halt or resume fact. A fresh-session
snapshot at **08:17:38.249–08:17:38.515 UTC** returned offset 81 and exactly 24
counted blobs. This establishes eventual durable processor recovery, not success
of the failed call. Wakes recurred approximately every 60 seconds while idle;
one bounded alarm trace contains `setAlarm` calls, but native telemetry alone
does not establish the cause of that cycle. Neither observation changes the
original test's result.

The first deployed resource run at **23:42:05–23:43:57 UTC** passed **4/5**.
Processor catch-up now passed, as did all three refusal/admission cases, but the
paged-read test failed after 3,106 ms with `Durable Object reset because its code
was updated`. The read-only control at **23:46:21–23:47:40 UTC** then passed,
including every byte of the same 24 × 6 MiB fixture. One unchanged full-resource
run at **23:51:23–23:53:17 UTC** passed **5/5** (read 4,175 ms, catch-up
4,209 ms), but later runs failed again. Neither that successful control nor the
absence of an OOM outcome explains the failed read. The successful run's local
JSON filename says `eleventh`; that label was mistaken. No eleventh deployment
had occurred: all these controls used version ten.

The failed read aligns with trace `7d445c8356fbb8ea72b3233b5bc8b513`. Its API
span `aceabc85be6216ea` runs **23:43:21.580–23:43:24.473 UTC** and completes
`ok`; its sequential DO invocations also complete `ok`. The final native
subrequest, `c847651818ca3f06`, starts and ends at **23:43:24.449 UTC** and has
no corresponding child DO invocation in the exact trace query. This localizes
the observed failure before the final request reached the DO handler. A caught
downstream RPC error can be returned over Cap'n Web while the outer handler
finishes normally: `ok` on that handler is not evidence of a successful page.
[Read-reset trace](https://dash.cloudflare.com/04b3b57291ef2626c6a8daa9d47065a7/observability/traces/7d445c8356fbb8ea72b3233b5bc8b513).

The query used `datasets: []`, that trace ID as the exact needle, and
**23:43:19–23:43:28 UTC** (84 rows). A separate service-only
`cloudflare-workers` query over **23:43:20–23:43:26 UTC** returned 57 rows:
44 DO invocations, 11 native get calls and two HTTP invocations, all version ten
and `ok`/info. Worker-log outcomes use `$workers.outcome`; OTel attributes use
`source.cloudflare.outcome`. Reusing one dataset's keys in the other can produce
a misleading empty aggregate.

Cloudflare documents eventually consistent code updates and other platform
shutdown causes, but the deployment record and these spans do not establish
which caused this reset. It remains unclassified; no automatic retry or
relaxed resource assertion has been added.
[Durable Object shutdown behavior](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/#shutdown-behavior).

### Subsequent reset and durable recovery

The frozen deployment later reproduced the read failure at **23:58:18.105 UTC**:
page 21, after offset 23, on `prj_membudget_mtp1l13b_0`. The original error
preserved `retryable: true` and `durableObjectReset: true`. This run used
Vitest's `--bail=1` with default and JSON reporters, so it finished teardown
and recorded the failure without retrying or interrupting the runner. The
other four resource tests did not run after that first failure.

Trace `0ef7885fb8e3cbbcd1d3ff4ef8af750b` has 20 completed native DO invocations
followed by a zero-duration 21st subrequest, `561b1f2fc190fbee`, at
**23:58:17.957 UTC**, with no child DO invocation. All observed invocations
are version ten; the exact **23:58:13–23:58:19 UTC** interval contains no OOM
outcome or recorded version transition. The preserved reset flags classify the
runtime's response, but do not explain what caused it.
[Page-21 reset trace](https://dash.cloudflare.com/04b3b57291ef2626c6a8daa9d47065a7/observability/traces/0ef7885fb8e3cbbcd1d3ff4ef8af750b).

On **6 September**, an operator-triggered fresh-session read resumed after
offset 23 at **00:07:00.330–00:07:02.112 UTC**, retrieving the four remaining
blobs exactly. A separate fresh session read the whole log at
**00:07:02.113–00:07:06.870 UTC**: 24 byte-identical blobs across 25 pages.
Repeating with the original client's full blob-retention pattern also passed:
the whole-log phase ran **00:12:40.206–00:12:45.142 UTC**, retaining all 144 MiB
before comparing bytes. No append was submitted and neither phase retried a
failed call. These prove preserved data and fresh-session recovery, not that
the original request succeeded or that the reset cause is resolved.

A one-variable diagnostic closed the seed's public session after the 24
appends and before the read opened its own session. It preserved every seeded
byte and the client's full-retention `Map`. The first fresh run passed 5/5.
The second, `prj_membudget_mtp2aysc_0`, closed the seed session at
**00:18:17.099 UTC**; its read passed in 4,513 ms, then catch-up failed in
2,971 ms with the same code-update reset. The runner stopped at that failure
and flushed its JSON report normally. Closing the seed session is therefore
not a sufficient correction; the temporary switch was removed. No production
behavior or resource assertion was changed by this diagnostic.

The failed catch-up trace `313186071a9a4ce72678238dc87383a8` differs from the
earlier read-reset trace: it reaches a DO handler, which records both configured
catch-up and delivery error logs. Its native entrypoint root lasts 1,288 ms at
**00:18:22.245–00:18:23.533 UTC**; its 1,265 ms subrequest is force-closed.
All observed events are version ten, without an OOM outcome. The surrounding
56 native entrypoint spans also finish promptly; the earlier 600-second
held-root pattern is absent in this control, but that does not explain the reset.
[Seed-close catch-up reset](https://dash.cloudflare.com/04b3b57291ef2626c6a8daa9d47065a7/observability/traces/313186071a9a4ce72678238dc87383a8).

### Later seed stall and bounded wire control

A diagnostic obtained a fresh project handle for each page while retaining one
public WebSocket session. Two fresh-seed reads passed (5,590 and 4,844 ms).
The third never reached the read: its seed hook timed out after 600 seconds on
`prj_membudget_mtp2pt72_0`, **00:28:35.739–00:38:35.759 UTC**. Thus that run
does not test the fresh-handle variable. The temporary handle change was removed.

A separate bounded, read-only session at **00:40:59–00:41:06 UTC** found
22 durable blob rows, with no repair or application append. The original trace
`58225f5d2190ca36f5929072480aabd8` contains 23 sequential native invocations:
22 `ok`, then one canceled call with no 23rd commit or 24th attempt. Its final
DO span has inconsistent timing annotations: its start/end timestamps imply
3,026 ms, but its `wallTimeMS` is 528,119 ms, matching the parent's 528,160 ms
through the hook cutoff. It is therefore unsafe to claim cancellation happened
nine minutes before the client timeout. The durable state is known; the reason
the append stalled is not.
[Seed-stall trace](https://dash.cloudflare.com/04b3b57291ef2626c6a8daa9d47065a7/observability/traces/58225f5d2190ca36f5929072480aabd8).

One fresh wire-observed seed at **00:49:45.673–00:51:01.930 UTC** completed all
24 distinct 6 MiB appends. Each awaited call received a matching `resolve` and
sent its `release`; none rejected or reached the diagnostic watchdog. Only
frame kinds, numeric IDs, lengths and times were observed, not payloads or
credentials. This was a non-reproduction, not an explanation of the stalled
seed. No retry or runtime change was introduced.

A targeted threshold control first confirmed the failed context still contained
exactly 22 blobs and no `n:22` or `n:23`. One new public append of the original
`n:22` / 6 MiB `w` body then completed at **00:54:28.138–00:54:31.705 UTC**.
An independent fresh-session read verified exactly 23 blobs, one byte-identical
`n:22`, and no `n:23`. This diagnostic intentionally added that one row; it did
not repair the full fixture or make the original timed-out seed successful.
It weakens a failure determined solely by the 22-row durable state.

Three planned full reads of the older, intact 24-blob context
`prj_membudget_mtp1l13b_0` then passed at **00:56:23.829–00:56:38.462 UTC**
(5,266, 4,747 and 4,617 ms). Each used a fresh authenticated public session,
one retained project handle, and a `Map` holding all 144 MiB until byte-for-byte
comparison. No upload or facet activation preceded these reads and no call
retried. This is further non-reproduction without recent seed workload, not
proof that reads after seeding are healthy.

A separate shared-session control at **01:01:13–01:02:29 UTC** used one public
session and project handle for both the 24-blob seed and full read. All operations
resolved and every blob matched. This differs from the original resource test,
which opens a second session for reading; it is not an original-test pass.
The planned original-handle/fresh-handle probes were conditional on a failed
read and did not run.

### Local loop minimization

The permanent public regression now runs **32 distinct sequential cycles**, not
ten: the isolated failure consistently appeared around cycles 21–23. There is
no retry after a failed upgrade. The unchanged real local harness failed on the
first run at **01:14:36–01:14:46 UTC**, iteration 23 / 6,211 ms. The same test
against version ten passed all 32 at **01:15:39–01:16:21 UTC** (40,940 ms test
duration). The other four admission tests were excluded by the name filter in
both commands. This is a local/deployed differential, not native stream-resource
acceptance. It can be reproduced from `packages/v4/project-worker` without a
diagnostic source edit:

```sh
pnpm exec vitest run --config e2e/vitest.config.ts rpc-admission \
  -t 'a finite rejected upload leaves the next public admission upgrade healthy' \
  --bail=1 --reporter=default --reporter=json --outputFile=/tmp/v4-admission.json
```

A 50-cycle version of the finite-refusal→WebSocket regression reproduced
without any other test workload (failure at cycle 23). Large-log seeding was
therefore not necessary. A standalone guard-plus-assets harness also had a
pre-open failure, but its client cleanup order differed and it did not capture
the HTTP status. It is not yet an equivalent minimum for the actual HTTP 500.
The temporary stress count is diagnostic, not a retry or an accepted replacement
for the ordinary regression.

The cleaned, unmodified full local suite at **00:24:21–00:24:46 UTC** still
failed: 239 ordinary passes, two expected failures, two actual failures and
15 skips across 64 files. Both actual failures are in admission: the direct
over-nested upgrade and the first finite-upload→upgrade cycle receive HTTP 500
before WebSocket open. The four serial standalone guard configurations each
passed 150 cycles, including the previously failing flags. This inconsistency
means the small harness is not yet a reliable reproduction of the full-suite
failure; neither a green stress sample nor the dependency upgrade closes it.

The actual five-test admission file and full two-worker harness provide a
stronger matched control. With only the loop raised to 50, the assets-enabled
arm failed at iteration 21 / 5,674 ms. Omitting only the main assets configuration
passed three 50-cycle boots; restoring it failed at iteration 21 / 5,676 ms.
This establishes an assets-dependent local boundary, not permission to remove
asset serving. A temporary downstream POST `Connection: close` diagnostic in
Wrangler's ProxyWorker did not help: baseline and patched arms both failed at
iteration 21 / approximately 5,673 ms. It rules out that particular correction,
not all possible pooling issues.

Finally, a temporary main wrapper that still evaluated and re-exported the real
worker module but handled requests directly with the admission guard and `{}`
reproduced at **00:48:30 UTC**, iteration 21 / 5,668 ms. Restoring the real main
reproduced at **00:48:45 UTC**, iteration 21 / 5,670 ms. Dashboard routing and
session allocation are therefore unnecessary; the other configured bindings
and module initialization remain in this minimum. All temporary wrapper,
configuration, dependency-header and loop-count changes were removed.

A failure-only observer on the actual Undici dispatcher subsequently captured
the iteration-21 HTTP 500 body: `Error: Network connection lost.` at the
Miniflare entry worker's `await service.fetch(request)` boundary. Its content
type was `text/plain;charset=UTF-8`; the four preceding admission tests still
passed. Thus the pre-open 1006 follows a real downstream HTTP failure, not just
a WebSocket client classification. The first observer attempt had a private
handler-binding error and is invalid diagnostic evidence; the corrected capture
is `/tmp/v4-rpc-admission-dispatcher-body50-2.json`. The observer was removed.

Keeping assets enabled but temporarily setting `run_worker_first: ["/api"]`
also failed at iteration 21 / 5,663 ms, followed by an unchanged control failure
at iteration 21 / 5,671 ms. The assets router's preliminary `unstable_canFetch`
RPC is therefore not necessary either. The routing overlay was removed.

Selecting only the fifth test, an ordinary-main baseline failed at iteration 23
/ 6,211 ms. A native vanilla handler with no Cap'n Web or V4 admission calls
failed at iteration 23 / 6,204 ms under the same assets harness and client. It
used the same incremental depth refusal, bounded drain and native coded
WebSocket close. Omitting only explicit `reader.cancel(refusal)` in the real
guard also failed at iteration 23 / 6,209 ms; its restored control failed at
iteration 23 / 6,211 ms. Thus neither Cap'n Web nor that explicit cancellation
call is necessary under this client's finite EOF/disconnect lifecycle.

A temporary Miniflare-only hop cut made `RPCProxyWorker.fetch()` forward
directly to `USER_WORKER`, preserving its class/Proxy wrapper and all assets
configuration but bypassing `RouterWorker`. Both the same-package baseline and
patched arm failed at iteration 23 (6,207 and 6,198 ms). The package's script
resolution was verified, but this cut had no runtime marker, so its negative
result remains provisional. A later attempted inverse cut changed only
dev-registry advertisement, not the served HTTP fallback; that result is
uninformative and is excluded.

The corrected inverse cut changed the actual served `fallbackWorkerName`, with
runtime route assertions in both arms. A POST-only `x-v4-diagnostic-stage`
header proved that the ordinary fallback traversed `RPCProxyWorker`; that
baseline failed at iteration 23 / 6,208 ms at **01:17:09 UTC**. Changing only the
served fallback from `assets:rpc-proxy:<main>` to `assets:router:<main>` then
passed **three fresh 32-cycle boots** (8,257 / 8,261 / 8,266 ms), with the helper
asserting the proxy header was absent on every POST. Assets and Router-to-user
forwarding remained enabled. Reports are
`/tmp/v4-rpc-admission-fallback-marker-baseline32-1.json` and
`/tmp/v4-rpc-admission-fallback-router-marker32-{1,2,3}.json`.

Further cuts retained the served proxy and asserted a POST marker from its
modified fetch handler. Each still failed at iteration 23:

- Omitting only the constructor's JavaScript `Proxy`: 6,219 ms.
- Forwarding directly to `USER_WORKER`, now runtime-marked: 6,193 ms. This
  supersedes the earlier unmarked negative; Router is not required for failure.
- Replacing the whole module with a minimal `WorkerEntrypoint` subclass that
  only forwards fetch to Router: 6,210 ms. Custom handlers/imports are not required.
- Giving the normal proxy exactly Router's compatibility date/flags: 6,219 ms.
  A separate startup marker verified the generated settings. That settings
  block is not a sufficient correction.

These distinguish the served proxy boundary from its custom JavaScript, but
do not yet identify the runtime mechanism. All temporary route, module,
settings and marker edits were removed; the public 32-cycle regression remains.
None of these diagnostic omissions is retained as a product change.

A captured handler-stage probe at **01:36 UTC** then reproduced at zero-based
iteration 23 / 6,224 ms. The first 23 upgrades each logged proxy entry, router
entry, router success `101`, and proxy success `101`. The failing 24th upgrade
had no proxy/router entry or handler-failure marker. This moves the next probe
outward to entry-to-proxy dispatch; it does not identify a native cause.
`/tmp/v4-rpc-admission-ws-stage-captured32-1.json` and its `.stdout.txt` sibling
hold the result. A prior attempt did not expose the harness's buffered logs and
provides no stage evidence. Both attempts' instrumentation was removed.

The next probe added the core entry worker's `await service.fetch(request)`
boundary and likewise found no captured entry for attempt 24. Crucially,
`server.getLogs()` collects only the main runtime's handler: Wrangler's outer
ProxyController owns a separate Miniflare runtime and logging path. Both use
the same physical core-entry script. Therefore the earlier 500 body pointing
to `entry.worker.js` does not by itself identify the main runtime.

The corrected two-runtime probe at **01:42:15 UTC** exposed both log sinks.
On the failed 24th upgrade, the outer entry and outer `ProxyWorker` both logged
entry. Its downstream fetch then rejected after roughly 1 ms with
`Network connection lost.` and `request.signal.aborted === false`; neither
the raw response callback nor the main runtime's entry executed. The prior
23 upgrades returned `101` through both runtimes. This locates the failure at
the outer proxy's network fetch into the main runtime, before main handler
dispatch; an abort signal was not observed at the catch. It does not yet prove
the underlying pool/body-lifetime mechanism. The artifacts are
`/tmp/v4-rpc-admission-outer-stage32-1.json` and
`/tmp/v4-rpc-admission-outer-stage32-1.stdout.txt` (iteration 23 / 6,257 ms).
All instrumentation was removed. The assets differential remains valid, but
may affect this outer transport's lifecycle rather than identify an error in
the asset proxy's native service implementation.

A TCP-bridge diagnostic at **04:04:36 UTC** used the actual
`src/api/startDevWorker/ProxyController.ts` controller, rewriting only the
outer proxy's main-runtime destination. A listening marker proved the active
hook; 32 POST/upgrade pairs then passed in 8,302 ms, on 64 distinct bridge
connections. Every POST returned `413`, followed immediately by a main-side
FIN; every subsequent upgrade used a new connection and returned `101`.
Artifacts: `/tmp/v4-rpc-admission-actual-outer-bridge32-1.json` and its
`.stdout.txt` companion. **This is a perturbing control, not a captured red
trace or a fix:** the bridge used Node's default half-close handling and
destroyed the counterpart on normal close. It may change exactly the native
close/reuse lifecycle under investigation. The test import was restored;
the bridge exists only in the isolated temporary Wrangler copy.

The follow-up half-close control also passed all 32 cycles. Both bridge
sockets used `allowHalfOpen: true`, normal close no longer destroyed the
counterpart, and piping propagated each FIN. All 64 connections were still
fresh: POST request/`413` response had no `Connection` header; GET/`101`
carried `Upgrade`. Every main-side FIN preceded the outer-side FIN. Artifacts:
`/tmp/v4-rpc-admission-actual-outer-halfclose32-1.json` and `.stdout.txt`.
This removes the explicit hard-close confound, but the inserted TCP hop still
changes scheduling. Neither bridge run captured the original failure.

The **04:19:12.432 UTC** non-interposed descriptor observation preserved the
original failure: iteration 23 / 6,219 ms, HTTP `500` and pre-open `1006`.
Port-only markers and child ancestry identified the main and outer runtimes;
approximately 100 ms samples counted numeric descriptors, not mapped files.
Throughout the observed sequence the main runtime held 50 descriptors / two
TCP sockets and the outer runtime 16 / three. On the first failure, before
test teardown, the main listener still had its unique owned PID and one fresh
direct HTTP request returned `HTTP/1.1 200`. This proves listener liveness,
not successful execution of the failed upgrade. There was no sampled
descriptor/socket accumulation; very short transients between samples are
not excluded. Artifacts: `/tmp/v4-rpc-admission-owned-fd32-1.json` and
`.stdout.txt`. The wrapper, port markers, failure-notification hook and import
override were removed; no request was retried or routing hop replaced.

## Ninth deployment: small ownership control passes, large catch-up fails

Main `2ac0b7b9-53b7-47c3-845e-8fa826a7cd03`, bundler
`dd07e228-a298-40d5-8b22-06f8d8972e0d`, main created at
**23:11:02.922417 UTC on 5 September 2026**. The SDK's two fixed-point stream operations
now dispose the resolved `ITX.get()` stub after the operation settles. This is
not yet sufficient resource-lifetime acceptance.

The public matrix at **23:20:13.260–23:20:34.145 UTC** passed **50/50 across
11 files**. A separate no-disable processor control at **23:15:27.100–23:15:30.423
UTC** passed and its 17 native get calls completed `ok` in 8–128 ms. The explicit
disable control at **23:15:35.521–23:15:38.779 UTC** had three short get
cancellations ending together at 23:15:38.621, consistent with its deliberate
facet shutdown; successful child invocations and that bounded timing distinguish
them from the earlier deployment-ended sessions.

The unchanged six-session publish control,
`2099595d-2e70-4d90-9bf5-e2e1e5e8af6f`, completed at
**23:24:24.499–23:24:31.625 UTC**. All public results completed and all sessions
were disposed. Its six API sessions and nine native DO invocations finished
`ok`:

| Operation        | Native invocation wall time | Trace                               |
| ---------------- | --------------------------- | ----------------------------------- |
| head             | 58 ms                       | `e12293781a34d693fbd30601bfaa967b`  |
| commit           | 65 ms                       | `9792539c7ccfd1a69f3489234a1c38cc`  |
| check            | 1,494 ms                    | `137e68529fc2bf634703f46b2e12e464`  |
| build            | 774 ms                      | `29f9d08bd0038b3ccba6105861546a2c7` |
| append           | 27 ms                       | `27f8af0df978605b5931b3c3af2944dc`  |
| combined publish | 1,669, 1,517, 36 and 29 ms  | `214e4af434b224f39b623b2e7fa2fa4a`  |

The service-filtered query over **23:24:23–23:24:33 UTC** returned 40 main rows,
all `ok`/info. Four bundler invocations were `ok`; its additional warning was the
experimental-API notice.
[Combined publish trace](https://dash.cloudflare.com/04b3b57291ef2626c6a8daa9d47065a7/observability/traces/214e4af434b224f39b623b2e7fa2fa4a).

### Resource failure: acceptance remains open

The resource matrix at **23:25:12.896–23:27:10.678 UTC** passed **4/5**. Paged
reading and the three admission/refusal scenarios passed, but processor catch-up
failed with `Durable Object reset because its code was updated` despite no
concurrent deployment. The exact main-worker interval returned 695 rows:
678 `ok`, 15 canceled and two error logs on the catch-up/delivery path.

A focused repeat gave stronger negative evidence: 20 native get roots on one
DO started at **23:31:11.091–23:31:13.432 UTC** and ended together at
**23:31:48.456 UTC** with `exceededMemory`, after successful child invocations.
The apparent code-update reset cannot be accepted as harmless deployment noise.
The working hypothesis is unresolved native RPC promise/result ownership in the
SDK; disposing only the resolved context stub has not proved sufficient.
[Memory-limit trace](https://dash.cloudflare.com/04b3b57291ef2626c6a8daa9d47065a7/observability/traces/528c0aec5fd425bef6fafce5d786088d).

### Local assets/upgrade differential

The minimal guard-only Wrangler harness reproduced the pre-open upgrade 500
only when static assets were configured. Wrangler 4.129.0 passed that minimum
with both graceful and abort/destroy client cleanup (50 cycles each), while
4.127.1 reproduced it. V4 now has a scoped 4.129.0 pin; other workspace apps'
Wrangler pins are unchanged. This is bounded evidence for the minimum, not a
full fix: the complete parallel V4 suite still reproduced pre-open 500 failures
on the verified newer runtime. Excluding the separate log-test harness did not
resolve them. The initial permanent public regression required ten finite rejected
uploads (since strengthened to 32 in the local-loop record above), each followed
by a successful WebSocket upgrade and the exact classified
admission close. No retry, skip, fixed delay or weakened assertion closes this
gate.

## Eighth deployment: final lint cleanup and public regression matrix

Main `67d741d2-c5bf-4cec-89a5-31432bd0ad4f`, bundler
`83ec6336-2084-42c0-b506-897b3d7bbeba`, deployed at approximately
**22:53:33 UTC on 5 September 2026**. This contains mechanical lint cleanup
after the seventh deployment's parser and lifecycle corrections.

The public matrix at **22:57:52–22:58:14 UTC** passed **50/50 across 11 files**:
processor lifecycle, trusted cleanup, checkpoint recovery, explicit source
replacement, native loader, build/check, repositories, provenance, admission,
OAuth/MCP and trusted secret egress. An earlier attempt used a broken diagnostic
WebSocket dispatcher and was stopped; it is not acceptance evidence. The passing
run used the ordinary Undici transport with that observer absent.

The unchanged six-session publish control,
`e0f5b90d-79d9-40b0-a961-3541112c1ed3`, completed at
**22:58:47.597–22:58:55.118 UTC**. All six public results completed, all six
API sessions finished `ok`, and all nine associated native DO invocations
finished `ok`:

| Operation        | Native invocation wall time | Trace                              |
| ---------------- | --------------------------- | ---------------------------------- |
| head             | 51 ms                       | `b724a455ac67a46a3c9b7192fab76d9c` |
| commit           | 59 ms                       | `7589b4952663a00c819be5f27780ec34` |
| check            | 1,558 ms                    | `fa19b6664f7f56f21366ece0b340082d` |
| build            | 676 ms                      | `62c448201311eee46cab6f68dce7659c` |
| append           | 28 ms                       | `b9738f8d0298d6778843f4ee35a6b86a` |
| combined publish | 1,643, 1,502, 37 and 29 ms  | `0f1a342646a5a0c50fb0b751e4e7a46c` |

The service-filtered query over **22:58:46–22:58:57 UTC** returned 91 main
rows: 90 `ok`/info and one canceled alarm at 22:58:46.488, before the control
started. That alarm is not part of any of the six control traces; its exact
cancellation cause is not recorded. The four bundler invocations were `ok`;
the additional warning was worker-bundler's experimental-API notice, not a
build failure. The query shape is documented in the seventh-deployment section.
[Combined publish trace](https://dash.cloudflare.com/04b3b57291ef2626c6a8daa9d47065a7/observability/traces/0f1a342646a5a0c50fb0b751e4e7a46c).

### Browser recovery and version boundaries

The browser recovered the existing shared document through the authenticated
Docs UI without editing it, then navigated away at **22:53:09.967 UTC**.
Actual browser navigations returned HTTP 200 and the exact previously published
Markdown from the project hostname at **22:53:27.009 UTC** (seventh main version)
and the custom hostname at **22:53:46.705 UTC** (eighth main version). Both
navigation log buffers were empty. This is recovery and post-disconnect serving
evidence, not another edit/check/build/publish proof. The earlier two-tab
convergence and publication evidence remains below.

### Open diagnostics, not accepted failures

The original local upgrade-500 response body was captured without retrying:
`Error: Network connection lost`, thrown while Miniflare's core entry worker
awaited `service.fetch(request)`. This happens before WebSocket open and before
an admission frame; Undici's 1006 is a consequence, not the cause. A bounded
single-boot differential passed ten plain WebSocket controls, then reproduced
the failure at the seventh finite-upload-cleanup→WebSocket cycle. The fixture's
upload teardown is under investigation; no runtime workaround is justified by
this evidence alone.

A separate deployment-boundary audit over **22:53:20–22:53:52 UTC** returned
1,015 main rows, including 788 canceled native calls. Three exact
`ItxEntrypoint.get` traces held context capabilities for 10–11 minutes after
fast successful child calls, then ended around deployment. The source audit
distinguishes the DO's bounded 60-second facet quiescence from ownership of
capabilities exported to loaded code. The traces do not retain the loaded-code
caller; they cannot alone distinguish intentionally retained capabilities from
missing disposal. This is an open ownership investigation, not an explanation
based on the rows being info-level.
[Example held-capability trace](https://dash.cloudflare.com/04b3b57291ef2626c6a8daa9d47065a7/observability/traces/e860071cbbc3dc2d684301196a51cd68).

## Seventh deployment: parser and trusted lifecycle corrections

Main `9af4918d-14c6-43ea-9359-c2eb8c8db403`, bundler
`76dcc8ff-ed6a-4120-b902-f4f4f1db4bf5`, deployed on **5 September 2026**.
Only the isolated v4 workers/routes were deployed. The shared JSON5 dependency
patch applies to other workspace consumers locally; no other app was deployed.

- At **22:42:27–22:42:45 UTC**, the public processor/trusted-lifecycle matrix
  passed **18/18**. The original 4.5 MiB literal-source append now returns
  `FACET_STARTUP_MEMO_TOO_LARGE`, `retryable: false`, leaves no facet installed,
  and commits neither submitted row. This closes the deployed parser regression,
  not a claim that every possible JSON5 allocation shape is memory-safe.
- The same matrix proves locked-policy terminal halt and final-pager cleanup,
  preservation of never-connected raw offline rules, checkpoint-halt recovery,
  and explicit disable→enable source replacement. Local Workers tests additionally
  cover pause→last detach→eviction→resume. Same-name re-enable without disabling
  remains an inherited, unspecified hot-reload limitation.
- At **22:47:27–22:47:39 UTC**, native loader, build/check, repository, provenance
  and raw admission tests passed **30/30**. At **22:47:44–22:47:47 UTC**, deployed
  OAuth PKCE/MCP and trusted one-shot direct-secret egress passed **2/2**.
- At **22:47:56–22:49:55 UTC**, the deployed resource matrix passed **5/5**:
  144 MiB paged reading, processor catch-up, oversized-event refusal, oversized
  receipt refusal and object-dense wire admission.

The unchanged six-session publish control was rerun without another foreground
test job: run `033676fa-12ed-4edb-9914-198487ba5903`,
**22:43:24.524–22:43:32.246 UTC**. All public results completed and all sessions
were disposed. Its six API trace IDs identify nine native DO `invoke` calls;
every one finished `ok`:

| Operation        | Native invocation wall time | Trace                              |
| ---------------- | --------------------------- | ---------------------------------- |
| head             | 59 ms                       | `5e4a3563ed09a4de9ac762e622636643` |
| commit           | 70 ms                       | `0a8eff7599716f65929e552aee855964` |
| check            | 1,815 ms                    | `0949f75643751e8e70e76c07d5f1ab8a` |
| build            | 500 ms                      | `fa95781e4725d336245630c0f2879822` |
| append           | 29 ms                       | `d1e181a86d3a833d4996cf0a10328340` |
| combined publish | 1,703, 1,554, 36 and 28 ms  | `531509cde78d7839899dad385144544f` |

The exact main-worker query over **22:43:23–22:43:35 UTC** settled at 89 rows,
all `ok`/info. It also includes background completion from prior tests, so 89
is not the control's call count. Its six API sessions and nine DO invokes are
grouped by the trace IDs above. All four bundler calls were `ok`/info.
[Check trace](https://dash.cloudflare.com/04b3b57291ef2626c6a8daa9d47065a7/observability/traces/0949f75643751e8e70e76c07d5f1ab8a).

The mixed lifecycle interval **22:42:26–22:42:48 UTC** settled at 294 main rows:
276 `ok`, 14 live `ItxEntrypoint.get` cancellations, three pager
`responseStreamDisconnected` outcomes, and one outer `/api` cancellation;
all were info-level, and all 217 DO `invoke` rows were `ok`. The pager traces
[`868d769e…`](https://dash.cloudflare.com/04b3b57291ef2626c6a8daa9d47065a7/observability/traces/868d769e610f9c3b4d287258dd0a61a0)
and [`77b4b2ab…`](https://dash.cloudflare.com/04b3b57291ef2626c6a8daa9d47065a7/observability/traces/77b4b2abc16aa35ee38221c3bf2d5463)
contain successful journal deletion under otherwise successful API sessions,
consistent with the tests' deliberate live-provider teardown. They do not expose
the peer's close reason. The canceled outer request's
[`fdb0b062…` trace](https://dash.cloudflare.com/04b3b57291ef2626c6a8daa9d47065a7/observability/traces/fdb0b06247ee82075ea25885f5bb3f8d)
contains six successful DO child calls and no error logs; its exact client-close
reason is not available. These are distinguished from inert-result native-call
cancellations, of which the unchanged publish control found none.

Exact query shape for these counts: account
`04b3b57291ef2626c6a8daa9d47065a7`, POST
`/workers/observability/telemetry/query` under that account, `view: "events"`,
`limit: 2000`, dataset `cloudflare-workers`, the stated UTC timeframe, and
`$metadata.service == "iterate-v4-simplification"`. The bundler query changes
only the service name to `iterate-v4-simplification-bundler`. Individual span
audits use dataset `otel` and exact `traceId`; automatic native span durations
and message suffixes are not substituted for invocation outcome/wall time.

Final local source gates after the parser/lifecycle changes passed all four
typechecks and 447 ordinary unit/Workers tests plus six inherited expected
failures. Full E2E diagnostics have both completely green runs and intermittent
HTTP 500s during local `/api` WebSocket upgrade, before an admission frame is
sent. Undici reports these as pre-open 1006 failures. No retry, accepted 1006,
or telemetry suppression has been added. The local 500 cause remains under
investigation; a later green run alone does not close that gate.

## Fifth deployment: native build/check lifetime control passes

Current main `3b5bd5ac-1566-4de0-9959-4ab73e6acf73`, bundler
`6399f6a9-2181-4fb4-aba0-b137e64c3b1f`. The unchanged control run
`d31be867-db57-4bf8-9a30-8325dc76b599` at **21:04:33.012–21:04:43.792 UTC**
returned all six expected public results and closed all six API sessions.
The exact `cloudflare-workers` query over 21:04:31–21:04:45 UTC returned
26 main-worker rows, all `ok`, with zero warning/error rows. Its nine probe
`IterateContextDurableObject.invoke` calls all finished `ok`; the four
cancellations present in the earlier identical control are gone. All four
bundler calls also finished `ok`. The bundler's sole warning is the library's
experimental-API notice, not an operation failure.

| Operation        | Main native outcome / wall time   | Trace                              |
| ---------------- | --------------------------------- | ---------------------------------- |
| head             | ok / 79 ms                        | `507ed06185992d53d9835d7e8da8f0de` |
| commit           | ok / 164 ms                       | `766c320aaacd6d3bfaadf6ed793668b2` |
| check            | ok / 2,730 ms                     | `b9cd1b5a27a9a15a1baa0001345282c0` |
| build            | ok / 866 ms                       | `dbe0f9a763ee6d00f2b1414d3d8507f2` |
| append           | ok / 27 ms                        | `d1078f1373bb71e5df521a99dbc39dcf` |
| combined publish | four ok / 2,757, 2,554, 59, 50 ms | `1f19d1a2e7238dad3f124e028dd23671` |

The diagnostic control established why cleanup was skipped: workerd attaches
an own `Symbol.dispose` data property to plain results of native RPC. The
conservative shape proof rejected that runtime-owned marker. The retained
change ignores only that marker for a known disposable native promise, while
still refusing to release capabilities, callbacks, streams, exotic values or
graphs beyond its proof budget. Public tests retain rewritten live/nested
capabilities. All temporary diagnostic code and project-name gating were
removed before this deployment. There is no inner-bundler change, retry,
expression-name exemption or telemetry suppression.

[The check trace](https://dash.cloudflare.com/04b3b57291ef2626c6a8daa9d47065a7/observability/traces/b9cd1b5a27a9a15a1baa0001345282c0)
contains 30 `otel` spans: API GET → Durable Object subrequest → native
`invoke`, plus the bundler's `check` and storage reads. All three explicit
invocation outcomes are `ok`. Its automatic bundler parent span is missing
from the returned set, and native span durations differ from invocation wall
times; those beta tracing limitations are not used to invent application
timing or parentage. The native invocation audit above is the cancellation
acceptance signal.

The same full local gates passed again before deployment (441 unit/Workers
passes plus 8 expected failures, 232 E2E passes plus 2 expected failures and
14 skips, full typecheck). The resource gate separately passed **5/5** on the
fourth deployment at 20:56:59–20:59:14 UTC after its wake-fact assertion was
corrected. Overall completion still requires the implementation-size target
and the remaining explicit defect/proof inventory; this control does not
claim every possible native RPC result shape has been proved inert.

### Browser teardown and upload-admission follow-up

The fifth deployment's browser published revision
`ac6b528283ace4284fa0aec9f642e49abca2c0de81611de443df200f34cbde32`
from the save/check/build/activate action at **21:08:27 UTC**. The editor
navigated to `about:blank` at **21:12:52.054 UTC**, ending its API/follow
connection. At 21:13:01.211 and 21:13:10.926 UTC, respectively, actual browser
navigations to the project and custom hostnames returned HTTP 200 and the exact
latest Markdown, including the new native-cleanup checklist item. Both browser
log buffers were empty for these actions.

The service-filtered `cloudflare-workers` query for **21:08:20–21:13:20 UTC**
(limit 2,000) settled at 557 main-worker rows: 548 `ok`, 9 `canceled`, zero
warning/error rows. All 268 `IterateContextDurableObject.invoke` rows were `ok`.
The nine cancellations were all `ItxEntrypoint.get`: four short-lived calls
belong to the two host navigations and their favicon requests; five earlier
calls held genuine context capabilities for 86–149 seconds. The entrypoint
returns a live `IterateContext` with invocation-scoped ownership, not an inert
build/check result; these info-level lifetime endings are distinguished from
the previously reproduced inert-result cancellation defect. This interval also
contains other synthetic preview activity, so its counts are not all browser
publication calls.

The browser publish trace
[`463fc0942d8eac25896da2ee72671e99`](https://dash.cloudflare.com/04b3b57291ef2626c6a8daa9d47065a7/observability/traces/463fc0942d8eac25896da2ee72671e99)
contains successful main invocations of 2,149, 317 and 279 ms; its longer live
handle invocation also ended `ok` at editor teardown. The bundler's `check`
(1,475 ms wall / 1,321 ms CPU) and `build` (262 / 226 ms) both ended `ok`, on
version `6399f6a9-2181-4fb4-aba0-b137e64c3b1f`. Its only warning was the
experimental-API library notice.

The deployed admission matrix passed **4/4** at 21:08:16 UTC. The finite
authenticated raw chunked HTTP test closes its source after about one second
and requires the coded 413 within two seconds total. It does **not** prove
response delivery while the client keeps uploading. An unended-body test now
exercises the real public `/api` handler through `SELF.fetch` in workerd: bounded
pulls and a classified response within two seconds, with a five-second hard
abort/cleanup. The deployed raw continuing-body controls did not establish
full-duplex response delivery, including on an immediately responding `/version`
control; no universal Cloudflare buffering cause or zone-setting fix is claimed.

The subsequent complete local rerun passed typechecking and **442 unit/Workers
tests plus 8 expected failures**, but exposed an intermittent **E2E failure**:
the over-nested WebSocket admission case received 1006 rather than its classified
3000 close. That complete result was 231 passes, one failure, 2 expected failures
and 14 skips. Five isolated repeats and two fully observed full-lane reruns
then passed. The strict 3000 assertion remains, with failure-only socket-lifecycle
diagnostics; no speculative server change or accepted 1006 fallback was added.
The cause is not yet proved, so later green runs do not erase this evidence.

A further full run reproduced that failure with `opened: false` and an error
event: the WebSocket handshake failed before the client sent its admission
frame. This distinguishes a connection-establishment defect from loss of the
classified close after admission. The test now records transport-error details
and closes its socket on every exit path; neither retries nor an accepted 1006
fallback were added. Three other failures in that run were traced to the next
local source-memo preflight change, which incorrectly probed unresolved
subscription targets; that preflight was removed and moved into the atomic core
state transition. Those local changes are not part of the fifth deployment.

At **21:24:15–21:24:17 UTC**, two deployed ingress checks passed: the published
project host still served the native-cleanup document, and a fresh leaf in
`prj_v4_demo` returned coded HTTP 404 (`PROJECT_FETCH_NOT_CONFIGURED`) when its
default fetch policy was asked to send back to that project's hostname. No
existing router was changed. The exact `cloudflare-workers` query for
21:24:14–21:24:20 UTC returned 17 rows: 16 `ok` and one info-level live
`ItxEntrypoint.get` cancellation from the successful published-host request.
The refusal's trace is `684449185118c53267fa6aca5dac0c75`, with HTTP 404 and
native outcome `ok`; there were no warning/error rows. This checks the
physical-egress guard, separately from the real browser's configured-host path.

## Third deployment: successful paths and failed acceptance controls

Main `f5e13084-d79d-417c-b879-45c44b5e330f` and bundler
`b2fcc615-6347-4dd4-b03d-cd64ff58e959` were deployed at approximately
20:45 UTC on 5 September 2026. The complete local gate preceding deployment
passed: typechecking; 441 unit/Workers tests plus 8 explicitly expected failures;
232 public E2Es plus 2 expected failures and 14 skips. Expected failures remain
defects, not passing behavior. The size gate failed at 13,899 implementation LOC.

- The deployed native-loader/build/repository/provenance matrix passed 26/26
  at 20:51:32–20:52:04 UTC. Separate deployed OAuth/MCP and encrypted-secret,
  trusted one-shot egress proofs passed 2/2 at approximately 20:48:18 UTC.
- Two authenticated browser tabs converged on a new Yjs edit. At 20:52:54 UTC
  the browser started save/check/build/activate and published revision
  `c06dcf5f5dc2a591a838f089f9904577d1d6a5ebea52fc520308d2613c9e4ef8`.
  After both editor tabs navigated away, both project and custom hostnames
  returned HTTP 200 with the exact latest document in the browser. No browser
  errors occurred during the authenticated edit/publish/serve sequence.
- The deployed resource run at 20:50:43–20:52:47 UTC passed 144 MiB paged
  reading and processor catch-up, oversized-event refusal, and object-dense
  pre-decode admission. Its receipt-refusal assertion failed because a fresh
  verification session advanced the head from 2 to 3. A minimized public probe
  at 20:54:23–20:55:04 UTC inspected all three rows: `stream/created`,
  `stream/woken`, `stream/woken` (all under `events.iterate.com/`). It found
  **no submitted blob rows**. The request returned `APPEND_REPLY_TOO_LARGE`,
  `retryable: false`; the extra row is the independently modeled constructor
  wake, not a partially committed 5,000-event batch. The assertion needs to
  preserve/check existing rows and allow only that wake fact.
- The exact 20:47:13–20:49:30 UTC service-filtered `cloudflare-workers` query
  returned 339 rows: 338 `ok`, one `canceled`, and zero error-level rows or
  memory-limit outcomes. The canceled row is an `ItxEntrypoint.get` capability
  lifetime in trace `18c5c0bf1f082aae33bd61ddfadbb423`, not a stream append.
  This interval includes controlled test traffic, not an unqualified clean bill
  of health for every path.

Two acceptance controls still failed on this version:

1. The unchanged six-session publish-lifetime probe, run
   `22d93696-edce-4db1-96ad-1e66a85fa9cc` at 20:45:47.910–20:45:57.600 UTC,
   returned all expected public results but retained four canceled native
   `IterateContextDurableObject.invoke` calls: check (1,729 ms), build
   (1,319 ms), and the two corresponding calls in the publish sequence
   (1,931 and 151 ms). All four bundler calls finished `ok`. Check trace:
   [683b6305146b22f17fd8f1a2ab451e45](https://dash.cloudflare.com/04b3b57291ef2626c6a8daa9d47065a7/observability/traces/683b6305146b22f17fd8f1a2ab451e45).
   The result-shape cleanup is therefore **not accepted as a fix**.
2. A continuing chunked upload did not receive a bounded admission response.
   Both the public E2E and a raw HTTPS/1.1 client reproduced this. Non-awaited
   request-reader cancellation is a candidate correction, not a verified cause
   or completed deployed fix until the same raw probe returns promptly.

A fourth diagnostic deployment is intentionally separate: main
`644dc444-0a15-4b04-833e-e6da25b0f488`, bundler
`05d32a96-328a-4e39-8680-32d470c6c30d`. It contains the cancellation candidate
and a temporary, synthetic-project-gated result-shape diagnostic for the RPC
lifetime investigation. It must not become the final retained deployment with
that diagnostic still present.

## Successful application path on the follow-up version

Main `4fb3a8e1-2497-461b-b920-9a7bff0fb51b` and bundler
`685f919a-1f83-4340-a4cf-1a57560fdb83` were deployed on 5 September 2026.
The second deployment's `/version` smoke passed. These checks used the isolated
v4 URLs and synthetic shared-sandbox identity, not an existing production project.

- Two actual headless-browser tabs at
  `https://v4.iterate2.app/docs?project=prj_v4_demo` converged on Yjs edits;
  reloading retained the materialized document.
- The browser's save/check/build/activate workflow recorded immutable repository
  revisions and ordinary durable activation/rewrite facts. The newest published
  revision is `71a3cee57ebcc16b4f1cb73d768e3229c352c466b093a639134e01e0cda76f3d`.
- Both `https://docs--v4-demo.iterate2.app/published-proof` and
  `https://v4-custom.iterate2.app/published-proof` returned HTTP 200 with the exact
  latest Markdown after the installer API session was disposed. The live browser
  independently verified the project-host body, not just the status.
- A fresh API session at 20:16 UTC read the latest revision and its parent
  `6e0765b46956a8fd6eb4fc604a81b3b274054570a1994caaec2a853a736df544`.
  The old revision still contains the unchecked activation item; the new revision
  contains the checked item and names the old revision as its parent. Publication
  did not mutate the old source snapshot.
- Deployed build/native-loader/repository/provenance E2Es passed 26/26. A separate
  deployed OAuth PKCE test registered a client, authorized a synthetic project
  through a manually inspected callback, exchanged the code, invoked real ITX
  KV write/read through MCP, and rejected a foreign project with 403. It passed
  1/1; no token or session cookie was retained in output.

The first publish failed on missing ambient types in the generated type graph.
The follow-up bundler fixes declaration traversal and checks against the real
emitted ITX interface. This is a collaborative Markdown-to-worker slice, not a
port of the complete Docs/task-board product or a general source editor.

The earlier self-loop was caused by installing the ingress rewrite with
`provide()`: its owner session correctly undid that rule on disposal. The proof
project now installs its router through an ordinary durable rewrite fact, and
serves correctly after session teardown. Separately, an unconfigured project
host still needs the local `PROJECT_FETCH_NOT_CONFIGURED` terminal guard deployed
to turn that missing-route state into a bounded 404 instead of self-recursion.

The browser's unexpected idle connection closure has not yet been reproduced.
A raw authenticated WebSocket remained idle for 175.8 seconds and then answered
`whoami`; only explicit disposal closed it (clean code 3000). A longer probe with
a real live-state subscription is ongoing. This does not establish a timeout
cause or justify an automatic retry/heartbeat workaround.

At approximately 20:10–20:14 UTC an incorrectly filtered test command started
the full remote suite. It was stopped; build and approval cases appeared in its
retained output. No resource-test name was retained, which does **not** prove
that none ran. This interval is contaminated test traffic, not a clean acceptance
window. Use `pnpm exec vitest run --config e2e/vitest.config.ts <test-file>` for
filtered runs; `pnpm e2e -- <test-file>` does not reliably filter this script.

## Scope and method

- Account: `04b3b57291ef2626c6a8daa9d47065a7`
- UTC window: `2026-09-05T19:32:00Z` through the audit at `2026-09-05T19:48Z`
- Services: `iterate-v4-simplification` and
  `iterate-v4-simplification-bundler`
- Query: `POST /accounts/<account>/workers/observability/telemetry/{keys,values,query}`;
  `datasets: []`, filter `$metadata.service = <service>`, event view, limit
  1,000. The aggregate intentionally reads only service, script version,
  outcome, event type/origin, level and bounded error class: no headers,
  cookies, request URL/query, or bodies were retained.

The telemetry key/value discovery found `cloudflare-workers` rows for both
services and no `otel` rows in this window. Cloudflare documents tracing as
beta with incomplete attributes and other limitations; absence here therefore
does not prove the absence of application activity. [Known tracing
limitations](https://developers.cloudflare.com/workers/observability/traces/known-limitations/)
apply.

## Observed intermediate versions

| Service                             | Script version                         | Returned event rows | Invocation rows                                           | Outcome rows                                                                                                           |
| ----------------------------------- | -------------------------------------- | ------------------: | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `iterate-v4-simplification`         | `304566f1-37c8-4c3b-944d-dc7f93f6f948` |                 843 | 583 jsrpc, 222 fetch, 24 alarm, 14 hibernatable WebSocket | 680 ok, 40 canceled, 9 response-stream-disconnected, 5 exception, 1 load-shed, 41 exceeded-memory, 67 no outcome field |
| `iterate-v4-simplification-bundler` | `752c50c5-ad1a-49c3-84d2-f335e7c0175e` |                  20 | 20 jsrpc                                                  | 15 ok, 5 no outcome field                                                                                              |

The main worker had 114 error-level rows. Their bounded, non-exclusive
classification was 103 memory-limit-related rows, 40 canceled outcomes, 9
response-stream disconnects, 5 other exceptions, 1 load-shed outcome and 4
internal-error log rows. These are event rows, not independent requests:
native invocation rows and their error logs can describe the same operation.
Without persisted traces or a controlled correlation ID, this baseline cannot
attribute them to one product path. The bundler had 15 info and 5 warning rows,
with no non-OK outcome field observed.

## Interpretation and next proof

The observed versions are the intermediate deployment: its browser publish
check rejected a bad generated type graph (missing ambient declarations), so
this baseline is evidence of the prior state only. It must not be used to
claim the pending deployment healthy or to normalize the main worker's error
volume.

The next deployment enables persisted tracing for both workers. After it is
live, run the same service-filtered aggregate over a fresh UTC window, then
follow each non-OK request through its `traceId` in `otel`, including its
version, parent/child chain, duration and application outcome. That proof must
also include the pending browser and deployed end-to-end checks.

## Follow-up deployment: trace audit (not accepted)

The follow-up main version, `4fb3a8e1-2497-461b-b920-9a7bff0fb51b`, emitted
persisted `otel` rows from `2026-09-05T19:48:00Z` to
`2026-09-05T19:52:29Z`. The bounded query returned its first 1,000 spans and
197 `cloudflare-workers` invocation/log rows: 82 traces, 711 parent links
present in the returned set, and no trace with multiple roots. The capped
result is sufficient to establish that tracing is now persisted, but it is not
a complete volume count.

This is not acceptance evidence. Six error-level log rows (one fingerprint)
are two representations each of three `GET /expression` operations at
19:48:31Z, 19:49:53Z and 19:49:55Z: the outer Worker and its
`IterateContextDurableObject` both carry `exception`. Each trace performed a
successful KV get before its Durable Object subrequest and exception outcome.
The operation inputs identify two `prj_capcode_*` and one `prj_tour_*`
synthetic context, all using `itx.site`; the corresponding public E2E cases
declare a successful HTTP 200, rather than an expected-error path.
The available error field contains only the request line and no stack or HTTP
response status; the native span presentation message says `OK` even when its
explicit outcome is `exception`. The same sample also contains nine
response-stream-disconnected and five canceled outcomes. These must be
correlated to the controlled browser publish and classified, or fixed; they
are not treated as normal noise here. Request queries, headers, cookies, and
bodies were not retained.

The bundler's new version, `685f919a-1f83-4340-a4cf-1a57560fdb83`, had no
post-deployment events in this window, so it has no trace proof yet.

### Browser 1019: confirmed self-recursion defect

At 19:55Z, browser `GET /published-proof` on the project hostname returned
Cloudflare error 1019. Its trace begins at the edge, makes one Durable Object
subrequest, then reaches `DummyControlPlane`; all retained native span outcome
fields say `ok`, but the trace ends before the platform's loop cutoff. This is
not a clean browser proof. Cloudflare defines 1019 as a Worker loop-limit
failure: Worker-to-Worker calls consume the `CF-EW-Via` allowance until the
platform refuses the request. [Cloudflare's Worker error documentation](https://developers.cloudflare.com/workers/observability/errors/)
supports that classification.

The deployed configuration binds `FALLBACK` to this same worker's
`DummyControlPlane`. Egress calls that binding; its implementation uses bare
`fetch(request)`, preserving the public project-host URL and re-entering the
same ingress, Durable Object, and egress path. The trace topology and the 1019
therefore identify a concrete self-recursion defect. A direct Node success
does not make the browser failure acceptable; compare the route and allowed
request metadata after fixing the recursive fallback path.
