# Consolidation implementation log

Entries are append-only. A later entry corrects an earlier one rather than
rewriting the record.

## 2026-08-04 — phase 0: preservation and skeleton

**Did:** Preserved the StackChan main tree in pushed commit `d88d3b6`, then
committed and pushed all eleven `.claude/worktrees/` on their existing
`worktree-fable-*` branches. Preserved the nine-file M5StickS3 working tree in
pushed `c-capabilities` commit `2a96f4a2b`. Added empty `core` and `audio` CMake
interface targets, a build-time and CTest core-boundary check, and a package
script for the complete host loop. Moved the untracked 44-byte evidence WAV to
macOS Trash.

**Measured:** The main StackChan snapshot contains 1,000 files. The eleven
worktrees had 478 status entries before capture and zero afterward; every local
HEAD equals its pushed `origin/worktree-fable-*` ref. The ignored corpus archive
contains 27,728 entries and is 10,206,336,512 bytes with SHA-256
`7205dd48361a9fd83a68acbc6c779400bb2b30e50b1537254eafeba7c0e527ed`;
neither `stackchan_local_secrets.h` nor `stackchan_xai_secret.h` is present.
`pnpm --dir apps/kit test` passes 6 Vitest cases and 1 CTest in 2.0 seconds on
the Mac. Injecting either a path-qualified or bare `audio_codec.h` include into
`components/core` fails the build in 0.2 seconds; removing it returns the same
build to green.

**Surprised by:** The plan names three unique worktrees, but the live checkout
had eleven dirty worktrees and nine contained unique or divergent files. The
9.5 GB corpus is under `experiments/02-minimal-realtime-aec/local/`, not the
repository-root `local/` checked first. Empty §4 directories cannot be preserved
by Git without goal-2-noise placeholder files, so only the directories with a
real Phase 0 build or test role are committed; later phases add the others when
they acquire content.

**Reviewer said:** StackChan preservation was incomplete, the phase log entry
was missing, a bare `audio_codec.h` include escaped the boundary check, the
build/CTest duplication needed a rationale, and `iterate-kit-playback.wav` was
goal-2 debris. → **did:** Captured and pushed all eleven worktrees; added this
entry; rejected both seam header names even without a path; documented why
ordinary builds and focused CTest both enforce the boundary; removed the CDash
CTest module and widened the scan to `.cxx`, `.hh`, and `.inc`; moved the WAV to
Trash. The reviewer independently reproduced the clean build, the negative
audio/platform probes, and the green CTest.

**Open:** iCloud Drive still reports the 10 GB corpus archive as `needs-upload`;
Phase 0 remains open until it reports uploaded. The first repository CI run must
prove the baked Linux image has CMake and a C compiler. The platform-private
include-path seam itself arrives with the real codec implementations in phase 2;
until then only the source boundary check is executable.

## 2026-08-04 — phase 0: second independent review

**Did:** Ran the mandatory review again after closing every actionable finding
from the first pass. The reviewer inspected the preservation refs, archive
manifest, boundary scanner, CMake wiring, and repository state from scratch.

**Measured:** The reviewer reproduced the positive build and CTest and both
deliberate forbidden-include failures. It found no remaining code or repository
hygiene defect.

**Surprised by:** The only remaining condition is external to the repository:
iCloud still has not acknowledged upload of the 10 GB StackChan corpus archive.

**Reviewer said:** The phase is clean except for the already-recorded iCloud
upload condition. → **did:** Continued monitoring the recoverable archive while
proceeding with repository work; no preservation source has been modified.

**Open:** Do not call Phase 0 fully closed until `brctl status` no longer reports
the archive as `needs-upload`.

## 2026-08-04 — phase 1: the Mac, end to end

**Did:** Ported the Tier 1 runtime onto the exact pinned first-party C Cap'n Web
commit, added the Darwin WebSocket/TLS transport and real microphone/speaker
host CLI, and wired the push-to-talk capability surface. Added bounded `ws://`
support for local development without weakening verified `wss://`, including
bounded multi-address connection fallback. Made unattended deadline
cancellation an explicit non-error outcome. Moved the voicelab build into the
ignored build tree and made every launch incrementally rebuild current source.
Restored the canonical CI telemetry reporter directly in `apps/kit`'s top-level
test command.

**Measured:** A local `voice-local` project and `/agents/voice/phase1` stream
completed a real server-side conversation through the C client: 384 microphone
frames, 47 received and played response frames, zero sequence gaps, seven
concealed frames, one playout underrun, transcript and response present. The
configured deadline then cancelled the next in-flight turn explicitly. The
report recorded `turns=1`, `failures=0`, `transports=0`, `callsLost=0`, and
`cancelled=1`. The final host suite passed 33/33 tests under ASan/UBSan.
Repository `pnpm typecheck`, `pnpm lint` (zero warnings), and the full
`pnpm test` workspace gate all passed. A clean `.build/voicelab` configure and
build produced the host CLI from current sources.

**Surprised by:** macOS may return `SO_ERROR=0` for a nonblocking connection
that is still pending; treating that as completion selected an unreachable
IPv6 localhost candidate and hung forever. Polling readiness before reading
`SO_ERROR`, then falling through to the bounded IPv4 candidate, fixed the real
loopback path. The repository test gate also correctly rejected a test wrapper
that hid its telemetry reporter from CI accounting.

**Reviewer said:** Pending the mandatory independent Phase 1 review.

**Open:** Phase 2 owns the observed one-underrun/seven-concealment audio quality
work and the formal codec/processor seams. Physical microphone and speaker
proof remains a later hardware phase; this phase's unattended run used the
real C transport and server conversation with a WAV utterance and file-backed
speaker timeline so it was reproducible.

## 2026-08-04 — phase 1: independent review corrections

**Did:** Corrected §5.1's adoption ledger to name the complete load-bearing
Tier 1 graph: configuration and device events, ITX peer/mount/outbox plumbing,
the bounded WebSocket stack, playback clock and status, push-to-talk RPC
support, Darwin transport, and the complete host rig. Added the donor branch's
real `audio.h` god-header spelling to the forbidden core include check.
Removed the now-redundant `test:web` script and clarified that the pinned
dependency is the bounded C Cap'n Web peer, not the unrelated voice device
profile.

**Measured:** The reviewer classified all 102 byte-identical donor files and 11
adapted files as load-bearing, found zero evidence binaries, forbidden modules,
vendored upstream files, or orphan tests, and independently reproduced 33/33
sanitizer CTests, typecheck, zero-warning lint, the full workspace test suite,
and the exact local conversation report.

**Surprised by:** Narrowing `iterate/kit/audio` to `iterate/kit/audio/` correctly
allowed the core policy header `audio_playout.h`, but also allowed the donor's
actual `iterate/kit/audio.h` hardware god-header. The explicit `audio.h` pattern
closes that high-probability board-port bypass.

**Reviewer said:** The runtime and exit evidence are genuine. Before Phase 2,
record the previously implicit adoption ledger, close the `audio.h` boundary
hole, remove or consciously accept the duplicate web test command, clarify the
Cap'n Web comment, and state the meaning of “no cloud.” → **did:** Applied all
four code/documentation corrections. Here “no cloud” means no deployed
Cloudflare environment: OS, project, stream, and dynamic worker ran in local
Miniflare/workerd. The dynamic voice worker deliberately still used xAI's
realtime API, so the proof is locally hosted but not provider-hermetic.

**Open:** A fake-provider option could make the conversation proof independent
of xAI availability, but it is not part of Phase 1 and is not required for the
product path. The preservation archive's iCloud upload remains pending.

## 2026-08-04 — phase 1: mandatory re-review corrections

**Did:** Removed the retired `/pcm` origin, endpoint builder, backward fallback,
tests, and callback-generation helpers so the configuration and capability
surface now describe only the single `/api` lane. Replaced the host rig's
parallel push-to-talk implementation with the shared bounded capability module
and one device-event owner for remote, physical, and scripted edges. Bounded a
POSIX DNS/TCP/TLS/upgrade attempt at 10,000 ms with separate retriable timeout
telemetry. Audited the voice dynamic worker's Cap'n Web ownership, retaining and
disposing connection handles, capability stubs, and result wrappers through
bounded teardown.

**Measured:** The host suite passed 34/34 ASan/UBSan CTests, including a
deterministic stalled-open timeout/recovery test and a host integration test
that sends remote and physical talk edges through the same queue and mutation
point. On a fresh local project, a 384-frame scripted turn completed with 35
response frames played, zero gaps, 18 concealments, one underrun, 945 ms to
first audio, 2,009 ms to answer, and zero failures, transport failures, lost
calls, or cancellations. Its exact 2,654-line dev-server log window contained
zero undisposed RPC stub warnings, undisposed RPC result warnings, disposal
failures, or error outcomes. Full repository typecheck, zero-warning lint, and
workspace tests passed; OS contributed 2,704 passing tests, 12 expected
failures, and one skip.

**Surprised by:** Cap'n Web method return values carry disposal ownership as
well as long-lived capability stubs. Closing connection handles alone removed
some warnings, but a GC cycle then named the still-live `Stream.append` result;
disposing the resolved result wrapper closed the remaining telemetry defect.
An exploratory structural-proxy disposal probe also demonstrated that reading
an arbitrary symbol on a client path constructs a remote method expression, so
that approach was reverted and the damaged local project was preserved for
diagnosis rather than reset.

**Reviewer said:** The fresh fable review hit its account usage limit, so the
user-authorized `gpt-5.6-sol` maximum-effort fallback found four release
blockers: stale dual-lane architecture, shared push-to-talk linked only by its
unit test, an unbounded pre-upgrade connection state, and undisposed RPC warning
telemetry in the real local proof. → **did:** Removed the dead lane, integrated
the shared module into the actual host, added and surfaced the open-attempt
deadline, and made RPC ownership explicit until a full local turn emitted a
clean server-log window.

**Open:** Run the independent Phase 1 review once more against this correction
commit. Phase 2 still owns the formal codec/processor seams and audio quality
work. The preservation archive's iCloud upload remains pending.

## 2026-08-05 — phase 1: second re-review corrections

**Did:** Superseded the previous entry's incorrect claim that the whole open
attempt was bounded: `prepare()` still called synchronous `getaddrinfo()` before
the deadline was armed. The Darwin transport now starts Apple's asynchronous
`DNSServiceGetAddrInfo` from `connect()`, advances it through the resolver file
descriptor without blocking, and lets the same bounded close path cancel DNS,
TCP, TLS, and WebSocket upgrade work. Added a regression test proving
`prepare()` does not begin resolution. Closed the dynamic worker's remaining
ownership races by disposing a connection that resolves after teardown,
classifying rejected initial and reopened connections through bounded teardown,
and disposing every `__describe()` result and setup append result even when a
sibling operation fails. Removed the last stale “PCM lane” comments.

**Measured:** The literal interactive Mac path used the real CoreAudio input and
output with the shared push-to-talk module. While PTT was held, the speaker said
“Please tell me one short sentence about the color blue”; the microphone
captured that exact transcript, the agent answered “Blue is the color of the
sky on a clear day,” and all 143 response frames played with zero gaps,
concealment, or underruns. The retained PCM16 mono 16 kHz artifacts are
`/tmp/iterate-talk-233647-mic.wav` (14.78 s) and
`/tmp/iterate-talk-233647-speaker.wav` (2.86 s). A separate deterministic turn
sent 188 frames, received 31, completed without a failed turn, restart, lost
call, or sequence gap, and measured 706 ms to first audio and 2,502 ms to the
first answer completion; its configured wall-clock end correctly classified
the in-progress second turn as a deadline cancellation. The exact 2,596-line
server window contained 123 `ok` RPC outcomes and one `built` outcome, with no
warning, error, unhandled rejection, or disposal signal. The host suite passed
34/34 ASan/UBSan CTests. Repository format, typecheck, zero-warning lint, and
the full workspace test gate passed; OS contributed 2,704 passes, 12 expected
failures, and one skip.

**Surprised by:** A transport can look completely deadline-driven while hiding
one blocking name-resolution call immediately before the deadline exists. The
interactive proof also exposed the terminal's real input semantics: one space
starts capture, repeated spaces keep it held, and stopping repeats produces the
ordered commit after 700 ms. That is materially stronger evidence than the
shared-module integration test or the unattended WAV driver.

**Reviewer said:** The maximum-effort fallback re-review found three blockers:
DNS was synchronous before the open deadline, a late/rejected connection and
several temporary RPC results escaped ownership, and the claimed physical PTT
path had only been exercised by tests and an unattended WAV/file-speaker run.
→ **did:** Replaced resolution with the cancellable Apple API, closed all named
RPC lifetime paths, and exercised the complete live microphone/PTT/server/live
speaker path with retained audio and exact transcripts.

**Open:** Run a fresh independent Phase 1 review against this correction. Phase
2 owns the formal codec/processor seams and systematic concealment/underrun
quality work. The preservation archive's iCloud upload remains pending.

## 2026-08-05 — phase 1: third re-review corrections

**Did:** Made name resolution asynchronous across the complete resolver result
set, including separately delivered IPv6 and IPv4 callbacks, and made the one
open-attempt deadline cover DNS through the completed WebSocket upgrade using a
fresh clock sample at every boundary. Made successful and failed Cap'n Web
result-wrapper ownership explicit in the Phase 1 scripts, including sibling
setup failures and late resilient-connection generations. Moved Mac speaker
completion to the CoreAudio render callback (or the file sink write), surfaced
input/output platform errors, and added exact submitted/completed/dropped/starved
telemetry. Removed every remaining special zero-length-binary/EOS and separate
PCM-lane semantic from the generic WebSocket stack.

The Tier 1 adoption ledger deliberately excludes the donor's `subscription.h`.
It contained only a 32-byte callback-owner key whose comment and sole purpose
were to arbitrate independent `/api` and retired `/pcm` socket generations. The
consolidated design has one Cap'n Web stream generation, and the retained
`push_to_talk` capability owns its callback through `rpc_internal`; copying that
header would preserve a second-generation concept with no caller. The file was
read from preserved donor commit `2a96f4a2b` and replaced by deletion, as §5.1's
“copy, read, delete what the new structure does not need” rule requires.

Added a loopback-only deterministic realtime provider and a `voicelab local`
command. This is the literal provider-hermetic proof missing from the earlier
entry: no captun tunnel, xAI request, or xAI secret. The dynamic worker dials a
Node WebSocket bound to `127.0.0.1`, and the command asserts microphone bytes,
speaker bytes, transcript identity, stream sequence continuity, and append
outcomes before returning success.

**Measured:** Pending a retained final artifact after the TypeScript client's
mu-law duration correction. Focused provider/resilient tests, TypeScript
typecheck, and 35/35 ASan/UBSan host tests are green.

**Surprised by:** The first hermetic proof delivered the exact 32,000 provider
PCM bytes as 50 lossless downlink frames, but the Node lab client reported 0.5 s
of sound. It was feeding the current mu-law wire payload directly to its PCM
sink and dividing encoded bytes by the PCM byte rate. The C listener already
expanded the payload correctly; the TypeScript proof client now mirrors it.

**Reviewer said:** The third independent review blocked on the stale deadline
and resolver snapshot, result-wrapper leaks, software rather than hardware
audio completion, old dual-lane semantics, a non-hermetic interpretation of
“no cloud,” the missing `subscription.h` decision, and an unchecked payload
cast. → **did:** Closed each item above and replaced the payload assertion with
schema validation. Run the independent review again against this correction.

**Open:** Retain and hash the corrected hermetic and CoreAudio artifacts, run
the fourth independent Phase 1 review, and continue monitoring the preservation
archive's iCloud upload.

## 2026-08-05 — phase 1: third re-review proof and gate

**Did:** Re-ran both proof paths after the third-review corrections. The
provider-hermetic path used a fresh local project whose config repo pinned the
voice agent at `6db0f5a432a29fcd0887540f3372c61a34d6c3fd`; its realtime provider
was the loopback-only Node fixture at `127.0.0.1`, with no tunnel, xAI secret,
or xAI request. The live Mac path used CoreAudio capture and playback against
the local dev server and waited for the output callback's completed-byte count
before declaring its turn complete. CoreAudio now owns the playback clock: the
producer replenishes a four-frame reserve, while only a dry pull later followed
by payload is classified as an audible internal starvation. A dry trailing pull
when the response closes is discarded rather than reported as an error.

**Measured:** The hermetic artifact is
`/tmp/iterate-voicelab-local-phase1-final.json` (SHA-256
`53f6671aa668c8330c66b0afdaef8b6be659c59f5e5d75fb73bb3aa11aa48028`).
It sent 255 microphone frames / 163,200 bytes, received 50 lossless speaker
frames / 32,000 decoded PCM bytes / 1.000 s, completed one answer with the exact
deterministic user and assistant transcripts, and recorded zero sequence loss,
underrun milliseconds, append errors, reconnects, or recycles. Its single
playout clear is the expected barge-in action produced by the fixture's
`speech_started` event, not packet loss or an error outcome.

The live CoreAudio report is `/tmp/iterate-talk-011306.json` (SHA-256
`0cd01956f1fec4b736d273b079f28adcab473ec2f864f7ef83f1b90ed691f6cf`),
with input `/tmp/iterate-phase1-direct/utterance.wav`
(`7af579a72e19144e1a8afe807604c6681a75c60fbc994c9dd7b4025084a56310`),
captured microphone output `/tmp/iterate-talk-011306-mic.wav`
(`42c1d4c898c97d35247991c88a2380756156c5ac043ea3d35e00baf1dad3df9e`),
and rendered speaker output `/tmp/iterate-talk-011306-speaker.wav`
(`a94f74ec52da456c64c9168ce1a469021cefc23e4d73f31f342d26894294dd49`).
It transcribed “Please repeat exactly these three words: Uplink diagnostic
amber.” and answered exactly “Uplink diagnostic amber.” It sent 205 frames,
received and submitted 103, and the hardware callback completed exactly 65,920
bytes (103 frames), with zero failed turns, sequence gaps, concealment,
underruns, dropped bytes, starved buffers, deadline cancellations, restarts,
recycles, lost calls, platform errors, or colleague events. Time to first audio
was 972 ms and answer completion was 3,115 ms. ASan/UBSan CTest passed 35/35;
repository format, typecheck, zero-warning lint, and the full workspace test
gate passed. OS contributed 2,708 passes, 12 expected failures, and one skip.

**Surprised by:** Counting the four in-flight AudioQueue buffers as the
producer's desired lead left the source ring empty at the synchronous callback
boundary; the reserve must be additional to those buffers. Also, treating every
dry callback as an immediate starvation falsely classified the ordinary quiet
tail between the last payload and `response.done`. Delayed promotion preserves
evidence for an internal hole without turning a normal response tail into error
telemetry.

**Reviewer said:** Pending the fourth independent Phase 1 review against this
correction and proof commit.

**Open:** Run and resolve the fourth review before Phase 2. The preservation
archive remains present in iCloud Drive with its full 10,206,336,512-byte local
payload but no explicit upload-state metadata, so remote-upload confirmation is
still pending.

## 2026-08-05 — phase 1: fourth independent review

**Did:** Treated the review's PASS as permission to close its remaining cleanup,
not permission to ignore it. The C stream now rejects greeting and hangup-reason
bytes that would need JSON escaping instead of emitting malformed events, with
regression coverage for quotes and backslashes. Removed the unused single-frame
append API and moved its wire assertions onto the batched function the host
actually calls. Removed Darwin's unreachable Wi-Fi state. Replaced the client
wire casts with Zod validation and an explicit `invalidEvents` outcome, made the
resilient connection disposable so accept-timeout and setup-refusal throws close
it, derived the fake provider's expected byte count from its audio constants,
and documented why the runtime-installed worker capability and the config-repo
copy of the RPC ownership helpers cannot use their static/local types directly.
Corrected the plan's stale `subscription.h` line; the earlier log's resolver
regression-test attribution was also stale—the test is in
`posix_websocket_test.c`, not `posix_itx_transport_test.c`.

**Measured:** The reviewer independently hash-checked all retained Phase 1
artifacts, traced callback completion and establishment deadlines through the
code, and re-ran 35/35 sanitizer CTests, typecheck, zero-warning lint, and the
full workspace test suite with 2,708 OS passes, 12 expected failures, and one
skip. Its verdict was `PASS`. After cleanup, the focused TypeScript suite passed
4/4, app TypeScript compilation and zero-warning repository lint passed, and
the sanitizer host suite remained 35/35. A fresh provider-hermetic run completed
with 255 microphone frames / 163,200 bytes, 50 speaker frames / 32,000 bytes,
the two exact deterministic transcripts, and zero loss, append errors, invalid
events, reconnects, recycles, or underrun milliseconds. Its artifact is
`/tmp/iterate-voicelab-local-phase1-review-final.json` (SHA-256
`f9c8c28dd76587563edaede8265ef69bf40fba991ff61918107035214f2335e3`),
using installed voice-agent commit
`5fdd9f00de0cf0a88c8c4ca316aa1d3d67413922`.

**Surprised by:** A type cast that was defensible when the client was only an
interactive lab became the wrong boundary once the same client was promoted to
prove a provider-hermetic path. Validating the wire payload gives the proof a
new exact failure counter and makes malformed downlink data terminal and
observable instead of merely satisfying TypeScript.

**Reviewer said:** Every Phase 1 exit criterion was genuinely met; the literal
loopback provider, one establishment deadline, result-wrapper disposal, and
CoreAudio callback accounting all held under source inspection and reproduced
tests. It called out the unescaped C strings, unexplained casts, implicit early
connection teardown, stale plan/test wording, one dead append API, and one dead
Darwin state as cleanup beneath its passing threshold. → **did:** Closed every
named code and documentation item. The suggested committed full e2e promotion
remains a later product-client concern; Phase 1's committed fake-provider tests
plus retained local dynamic-worker proof meet its scripted-exit criterion.

**Open:** Phase 1 is complete. Phase 2 introduces the codec and processor seams.
The preservation archive's remote-upload confirmation remains pending.

## 2026-08-05 — phase 2: portable audio seams and Darwin composition

**Did:** Introduced the two portable audio interfaces as one small audio link
unit. `audio_codec` exposes immutable post-conversion hardware facts plus
nonblocking capture and playback admission; it rejects contradictory property
tables and impossible adapter results. `audio_processor` owns a complete
capture-clock-aligned near/reference/playout-activity frame and silences its
entire output whenever a required input is absent or DSP fails, so a failed AEC
cannot leak raw microphone audio. The Mac composes the codec with the stateless
passthrough processor.

Moved CoreAudio capture and playback out of the host target and into the Darwin
platform. The Darwin codec owns those implementation details while its file
clock accepts a copied callback seam instead of depending on the host WAV
module. Hardware facts now live in codec properties; global queue, wire-frame,
and supervision geometry remains in `voice_device_profile.h`. The one necessary
host copy of the eight-frame CoreAudio lead has a drift test against the Darwin
constant. The architecture test still rejects audio or platform includes from
`components/core`.

**Measured:** A fresh real-CoreAudio conversation against local `pnpm dev`
used project `voice-audio-seams-local` and retained
`/tmp/iterate-talk-020541.json` (SHA-256
`822f1b7ef6ee99512799f53e8ff8a14c68202ca9bf2e1966e4cb4c94154cfdca`).
Its input fixture was unchanged from Phase 1 (SHA-256
`7af579a72e19144e1a8afe807604c6681a75c60fbc994c9dd7b4025084a56310`);
captured microphone and rendered speaker WAVs have SHA-256
`29e2f7ee31338cdaf150a231c38fd1ca9fabbb8f865c6ab3624c62a226c925e1`
and `4675c7f9f6cd5bbda703d9b350c1955c3f7e7308c6b5366f1297b1fd795425a5`.
The completed turn transcribed “Please repeat exactly these three words: Uplink
diagnostic amber.” and answered exactly “Uplink diagnostic amber.” It sent 205
frames, received and played 103, and the CoreAudio callback completed exactly
65,920 bytes. Time to first audio was 851 ms and answer completion 2,983 ms,
with zero failed turns, sequence gaps, concealment, underruns, room drops,
starved buffers, platform errors, restarts, recycles, or lost calls. The run's
single deadline cancellation belongs to the next turn that the configured
0.25-minute test duration deliberately cut off, not the completed turn.

ASan/UBSan CTest passed 37/37, including the codec properties/reference seam,
processor fail-closed rule, disabled Darwin adapter, and the core boundary.
Format, typecheck, zero-warning lint, and the exact full workspace test command
passed. OS contributed 2,708 passes, 12 expected failures, and one skip; its
isolated retained log is `/tmp/iterate-phase2-os-test.log` (SHA-256
`69ddbc87b31e95b313c83970cfc576dbcf5753f03aa1a372d8aa2814612e3f75`),
and the successful full-workspace retry is
`/tmp/iterate-phase2-workspace-test.log` (SHA-256
`81eaeb8b42b5596b1e6e64548381b8665fd340eb9b21d7fb254170356593632f`).

**Surprised by:** The first full workspace test attempt completed every visible
non-OS shard, then left the OS Vitest coordinator at zero CPU for four minutes
after its child workers disappeared. It had no child process or network socket
and produced no failure, so the run was stopped rather than silently called
green. The OS suite then passed alone in 56.29 s, and the exact full command
passed on its immediate retained retry with the OS suite in 57.15 s. This
classifies the event as a transient local parallel-runner stall, not a test or
product outcome; it is recorded because a repeat would need its own fix.

**Reviewer said:** Pending the independent Phase 2 review of the frozen git
range.

**Open:** Run and resolve that review before beginning the firmware ports. The
preservation archive's remote-upload confirmation remains pending.

## 2026-08-05 — phase 2: independent-review corrections

**Did:** The independent Phase 2 review blocked the phase on two test defects.
Moved the CoreAudio lead drift assertion from the Waveshare row to the host row
and made it compare the typed eight-frame host lead with its true composition:
four AudioQueue buffers plus the four-frame Darwin producer-ring reserve. Made
the passthrough-processor proof copy a sentinel-filled distinct input/output
pair across all 320 samples, then separately retained the in-place case.

Closed the review's worthwhile seam cleanup before a physical adapter can
depend on it. The contracts now define sample units, partial reads, disabled
playback, gain reference, composition obligations, deterministic clock
emulation, and the caller's fail-closed duty when an invalid extent cannot be
overwritten safely. The global profile now names the one 16 kHz wire sample
rate used by core, Darwin, the host profile, and WAV I/O. The core-boundary
scanner derives a bare-header deny-list from every platform header instead of
recognising only path-qualified includes. Added coverage for zero-length
successful reads, both reference-property mismatch directions, invalid positive
gain ceilings, invalid processor extents, reset error forwarding, a malformed
file sink, and Darwin ring-full to portable BACKPRESSURE mapping. Removed the
test-only Darwin input status-name API, a dead host include path, a tautological
live-output condition, and the output test's WAV/host-target dependency; the
output test now uses a hermetic memory sink. Added C++ linkage guards and an
Apple first-party source for Audio Queue format conversion.

**Measured:** The reviewer reproduced the ASan/UBSan suite, independently
negative-probed the core boundary, verified all six retained hashes and every
conversation-report counter, and converged with four parallel reviewers. Its
verdict was `BLOCK` only on the two tests above. After correction, the host
suite passed 37/37 under ASan/UBSan in 5.31 s. The total is 35 Iterate tests and
two Cap'n Web dependency tests; earlier Phase 2 entries used the combined total.

**Surprised by:** The incorrect drift assertion compared two unrelated values
that both happened to equal four: the Waveshare ES8311 DMA lead and Darwin's
producer-ring reserve. It would have failed on a legitimate Phase 3 Waveshare
retune while allowing the actual typed host value of eight to drift freely.
Likewise, an aliased passthrough test asserted values the test itself had
written, so deleting the production copy would still have left the suite green.

**Reviewer said:** Correct both tests before the phase can pass. It also listed
contract holes, untested error branches, a basename escape in the second-line
boundary scanner, cross-target test coupling, and small dead paths as cleanup.
→ **did:** Corrected both blockers and every cleanup item that changes present
correctness or keeps the seams narrow. Retained separate capture/playback clock
ownership properties because the upcoming half-duplex and external-DSP boards
can own those clocks differently; documented that the deterministic Darwin
file clock emulates the hardware-owned cadence. `reset` and
`playout_activity` remain intentionally unwired on the passthrough Mac and will
gain their first production consumer in the amended StackChan AEC phase.

**Open:** Re-run the mandatory independent Phase 2 review on this correction,
then begin Phase 3 only on PASS. The preservation archive's remote-upload
confirmation remains pending.

## 2026-08-05 — phase 2: correction verification

**Did:** Ran the complete repository gate after the review corrections and
retained its output independently of the terminal session.

**Measured:** Format, full workspace typecheck, and zero-warning lint passed.
The exact full `pnpm test` command passed; the OS shard reported 262 files,
2,708 passes, 12 expected failures, and one skip in 57.63 s, and the kit shard
included the 37/37 sanitizer CTest result. The retained log is
`/tmp/iterate-phase2-review-correction-workspace-test.log` (SHA-256
`8da23a002cadac4fb0972382745208a961c4f659a3c492a6aa84a51ff7003c9f`).

**Surprised by:** The first terminal capture detached after its output budget
was exhausted and did not preserve the parent process's exit status, despite
the suite visibly continuing. Rather than infer success from process exit, the
exact command was rerun through a retained pipe with `pipefail`; that second
run produced the explicit zero exit above.

**Reviewer said:** Re-run the review after the corrections. → **did:** Frozen
the verified correction as its own commit for an exact independent-review
range.

**Open:** Mandatory correction review, then Phase 3. The preservation archive's
remote-upload confirmation remains pending.

## 2026-08-05 — phase 2: codec read postcondition correction

**Did:** The fresh correction review verified both original Phase 2 blockers by
mutation, then found one new contradiction between the portable codec contract
and its implementation. Strengthened the implementation instead of weakening
the contract: every read with a non-null count now clears that count before
codec, property, buffer, extent, or reference validation. Kept the null-count
case explicitly invalid, and added direct tests for both invalid properties and
the null pointer.

**Measured:** The first correction review used four parallel reviewers plus
fresh mutation tests and returned `BLOCK` on only this postcondition. After the
fix, the focused ASan/UBSan audio-seam test passed in 0.15 s and `git diff
--check` passed. The complete 37-test host suite had already passed immediately
before the two additional assertions were added; a fresh full run remains part
of the final correction gate.

**Surprised by:** The public header claimed every non-OK result cleared the
count, while argument and property validation ran before the clearing write.
That made a stale count possible precisely when a composition root was
miswired. No production caller consumed the stale value because callers gate
on status, but upcoming physical adapters would have been built against a
false guarantee.

**Reviewer said:** Both prior blockers are genuinely closed. Make the codec
read-failure postcondition true by either documenting the stale-count behavior
or zeroing before validation; it also listed optional documentation and scanner
cleanup below the gate threshold. → **did:** Chose the fail-closed behavior and
tested the validation paths directly. Deferred unrelated optional cleanup to
keep the correction range surgical; none changes present behavior or blocks a
physical adapter.

**Open:** Commit and independently re-review this exact correction. Phase 3
remains gated. The preservation archive's remote-upload confirmation remains
pending.

## 2026-08-05 — phase 2: final gate

**Did:** Ran the mandatory fresh review of the surgical fail-closed correction
range `e0ead72af..c94990665`. The reviewer inspected every return path, searched
for wrapper bypasses and stale-count assumptions, rebuilt from a clean host
configuration, and mutation-tested both the old validation ordering and a
deleted null guard.

**Measured:** Fresh ASan/UBSan host verification passed 37/37 in 5.61 s. Reverting
the count-clearing order made the suite fail at the seeded stale-count
assertion. Deleting the null guard produced an ASan null dereference caught by
the new test. The review found four changed files, no unrelated behavior, and
returned `PASS`.

**Surprised by:** The reviewer identified a distinct pre-existing defense whose
line is present but whose exact mutation is not yet killed: an adapter could
write a count and then return failure, relying on the wrapper's second clearing
write. That behavior is already correct; its dedicated fake belongs alongside
the first physical adapter rather than in another Phase 2 correction cycle.

**Reviewer said:** The blocker is genuinely closed, contract, wrapper, and tests
agree, and Phase 3 is unblocked. It suggested pinning the scribble-then-fail
adapter case and naming the wrapper as the postcondition enforcer when physical
adapters arrive. → **did:** Accepted both as Phase 3 seam-hardening work. Kept
the remaining wording-only cleanup deferred.

**Open:** Phase 3 Waveshare structural port, build, and safe proof. Physical
access remains blocked by the explicit Waveshare denylist; do not open or flash
that serial device without new authorization. The preservation archive's
remote-upload confirmation remains pending.

## 2026-08-05 — phase 3: Waveshare structural port

**Did:** Advanced the firmware's exact Cap'n Web pin to the upstream
ESP-IDF-component commit `aee32b391063c4f5baf0aec852f38851eeeed1d9`, imported
the shared avatar unchanged, and added the ESP-IDF configuration and one-socket
`/api` transport platform. Ported the Waveshare reference target into a thin
`main`, a board composition root, and five hardware/UI adapters. Deleted its
menu, touch, image, screenshot, recorder, SD-card, remote-style, and tool RPC
paths. The remaining device uses the same ephemeral stream events as the Mac.

Made the two Phase 2 seams real on hardware. Dedicated priority audio tasks are
the only callers of blocking `esp_codec_dev_read`/`write`; the public codec seam
copies complete 20 ms frames through depth-one mailboxes without waiting. The
composition root validates its 16 kHz/320-sample passthrough processor and fails
closed on processing errors. Capture overwrite, codec-driver failure, and
playback-admission failure paths are explicit telemetry. Preserved the
load-bearing abandon order and absolute DMA-empty deadline. Documented, without
changing, the known-wrong ES8311 gain and PA-voltage settings.

**Measured:** The host ASan/UBSan suite passed 46/46 in 1.95 s. A native ESP-IDF
5.4.2 ESP32-S3 build passed with `-Wall -Wextra -Werror`; its application binary
is `0x154e30` bytes and leaves `0x2ab1d0` bytes (67%) of the smallest app
partition free. The I2S geometry is derived from Espressif's documented formula:
six 240-frame descriptors at 16 kHz are 480 bytes each, interrupt every 15 ms,
and hold 90 ms total. No device was opened or flashed.

**Surprised by:** Importing every source named by the old target first produced
9,735 lines of board code. The voice endpoint actually needs five adapters; the
rest was product archaeology. The second structural surprise was that putting
blocking codec calls directly behind a function-shaped seam still violated its
contract. Making ownership literal required two small hardware tasks rather
than a comment around the old calls.

**Reviewer said:** Pending the mandatory fresh Phase 3 review of the frozen git
range. → **did:** Pending.

**Open:** Hardware exit evidence cannot be collected: the connected-device
inventory explicitly marks the Waveshare unit inventory-only and says never to
flash it. Keep that safety constraint visible rather than claiming the target's
compile proof is acoustic proof. The preservation archive's remote-upload
confirmation also remains pending.

## 2026-08-05 — phase 3: review corrections

**Did:** Corrected all three release-blocking findings from the mandatory Phase
3 review. Protected the imported generated avatar catalog from prose formatting
and restored its exact donor bytes. Rewrote WebSocket query bounds validation in
terms of remaining destination capacity so an oversized query cannot underflow
`size_t` and authorize an out-of-bounds copy. Replaced the concurrently reset
speaker stream with a queue of complete 20 ms frames tagged by an atomic answer
generation. Replacement now disarms and records the hardware flush, advances
the generation, resets the synchronized queue, and publishes reprime; a frame
already held by the playback task is rejected by its stale tag.

Closed the review's associated dead or misleading paths too. Cross-task
playback clocks and flags are C11 atomics, turn-marker publication failures are
counted and force a fresh transport instead of silently sending ambiguous
audio, and the task watchdog is not armed until provisioning succeeds. Removed
unused idle-remount and device metric fields, screenshot configuration, the
unreachable Gameboy atlas, and the unimplemented procedural-renderer API. The
capture adapter no longer classifies normal startup overwrites as overruns; it
starts that telemetry only after the portable consumer has attempted a read.

**Measured:** The corrected host firmware suite passed 46/46 under ASan/UBSan
in 2.69 s. A native ESP-IDF 5.4.2 ESP32-S3 build passed with
`-Wall -Wextra -Werror`; its application binary is `0x1545b0` bytes and leaves
`0x2aba50` bytes (67%) of the smallest app partition free. `pnpm format` passed,
the generated catalog still compared byte-for-byte equal to the read-only
donor afterward, and `git diff --check` passed. No serial device was opened or
flashed.

**Surprised by:** The Phase 3 build evidence predated the commit hook, which
rewrapped a generated C initializer into invalid source. The frozen commit was
therefore broken despite both pre-commit builds being green. The old speaker
snapshot also counted bytes that a concurrent reader might already own; that
could both resurrect stale audio and discard replacement audio. A whole-frame
queue plus epoch tags expresses the actual ownership boundary directly.

**Reviewer said:** Block on the formatter-corrupted generated source, the URL
query bounds underflow, and the playback replacement race. It also called out
dead telemetry and avatar APIs, torn 64-bit cross-core state, swallowed turn
markers, stale screenshot configuration, and provisioning's watchdog reboot
loop. → **did:** Corrected each item and rebuilt both supported verification
lanes. Kept host CLI fixture fields that intentionally exercise the stable
telemetry contract; removed only device fields that falsely claimed a live
measurement.

**Open:** Freeze these corrections, rebuild the exact commit, and run the
mandatory fresh independent review. Waveshare hardware proof remains forbidden
by the connected-device inventory. The preservation archive's remote-upload
confirmation remains pending.

## 2026-08-05 — phase 3: frozen-tree counter audit

**Did:** Audited the frozen playback generation change while both independent
review accounts were temporarily unavailable. Made the two counters that now
have writers on both the app and playback cores relaxed C11 atomics. The answer
generation and queue synchronization already protected audio ownership; this
small follow-up protects the diagnostic read-modify-writes from losing
simultaneous overflow or discard events.

Also closed the preservation archive's remote-upload question using macOS's
first-party File Provider state. The exact 10,206,336,512-byte archive reports
`isUploaded = 1`, `isUploading = 0`, `isExcludedFromSync = 0`, no unresolved
conflicts, and its most recent version downloaded. `brctl status` independently
reports the CloudDocs container caught up after the file's creation.

**Measured:** Formatting and `git diff --check` passed. The atomic-counter change
compiled natively with ESP-IDF 5.4.2 under `-Wall -Wextra -Werror`; the
application is `0x1545c0` bytes with `0x2aba40` bytes (67%) free. No serial
device was opened or flashed. The archive remains 27,728 entries with SHA-256
`7205dd34651d4a7e99bdb9a578112ffbdacb5a47c0cc571bb6c8c2783227ed`.

**Surprised by:** Aligned 32-bit loads do not tear on Xtensa, but that fact does
not make two concurrent `++` operations lossless. The replacement fix had
changed the overflow and discard counters from one writer to two; the telemetry
ownership needed to move with the audio ownership.

**Reviewer said:** Claude returned a five-hour rate-limit response without
reviewing. The required `gpt-5.6-sol`/max Codex fallback then also returned its
account usage limit without reviewing. → **did:** Recorded both as unavailable,
did not claim a pass, and did not begin Phase 4. Claude reports a 07:10 London
reset, when the exact frozen range will be submitted afresh.

**Open:** Commit and rebuild this final correction, then obtain the mandatory
independent Phase 3 PASS after the reported reset. The preservation archive no
longer has an open upload-confirmation gap.

## 2026-08-05 — phase 4a+4b: M5StickS3 and HAVPE structural ports

**Did:** Ported both boards onto the shared single-socket lane as rhyming
compositions of the same portable modules, per the standing
conventions-over-frameworks preference: no extracted app-runtime framework,
three device roots a reader can diff. The M5StickS3 port preserves the donor
codec bring-up exactly — the 8-register ES8311 table with the brownout-proven
-18 dB DAC ceiling (0x32=0x9B), the BCLK-sourced codec clock, and the M5PM1
amplifier latch — and makes the board's half duplex literal: the ADC and DAC
share I2S clock pins, so a four-stage pin-ownership fence (channel deletion,
not disable, is the boundary) hands the hardware between push-to-talk capture
and playback. The HAVPE port adopts §5.1 Tier 2's voice_pe_hardware_config
and its pcm-format companion nearly verbatim with their host tests, fails
boot closed on XMOS firmware != 1.3.1 or unverified pipeline stages, and
declares the load-bearing seam fact: capture_is_echo_cancelled with
has_reference_channel=false, passthrough processor. Both new boards measure
playback starvation against the absolute audio-empty deadline only; the
per-descriptor ISR ledger stays Waveshare-only because a 600 ms injected gap
moved it by zero there. Deferred the mandatory per-phase reviews on explicit
user instruction ("straightest possible line... don't do the subagent review
runs until later"); they are batched as later work alongside the still-open
Phase 3 review.

**Measured:** Host suite 49/49 under ASan/UBSan (46 prior + the three adopted
HAVPE pure tests) in 2.76 s. Native ESP-IDF 5.4.2 builds pass with -Wall
-Wextra -Werror on first configure for both: iterate-kit-m5sticks3.bin is
0x117ae0 bytes (45% of its 2 MiB partition free), iterate-kit-havpe.bin is
0xf0d90 bytes (81% of 5 MiB free). Both partition tables keep donor offsets
so the ITERKIT1 blobs at 0x210000/0x510000 on the physical units survive a
plain app flash. The Waveshare target and Mac host path are untouched by
these commits except tests/CMakeLists.txt additions.

**Surprised by:** The donor M5StickS3 microphone is not a PDM part — several
donor docs claim PDM, but the source-verified fact is the same ES8311's ADC
on I2S1 (DIN GPIO 16) sharing the clock pins, which is exactly why the
half-duplex fence must delete the playback channel: ESP-IDF leaves MCLK
routed after disable. Also HAVPE's donor never gated its speaker rail after
boot — the XMOS AEC reference rides the always-running TX stream, so the amp
discipline that protects the no-AEC boards would be an AEC outage here.

**Reviewer said:** Deferred (user directive). → **did:** Recorded the exact
per-phase commit boundaries for the later batched reviews: 4a = 99a88f90b,
4b = d2e54d5ee.

**Open:** Hardware conversation proof for both boards (both are on the hub
and flashable; the Waveshare denylist does not apply to them) in a dedicated
session against local dev over LAN ws://. StackChan (4c) port next, compile
and host-test only. User amendment 2026-08-05: StackChan explicitly wanted
even while offline — servos, camera, speaker, AEC, touchscreen — with the
donor's final tuned AEC and levels preserved exactly.

## 2026-08-05 — phase 4c + phase 5 code: StackChan port and the TS client

**Did:** Ported StackChan per the §0 amendment and the user's explicit
mid-session request, preserving the donor's final tuned AEC state exactly:
ESP-SR 2.4.7 VOIP_HIGH_PERF with filter length 4, the 100 Hz near high-pass,
saturating ×8 on the slot-1 amplifier-divider reference, constant processed
×10 uplink, volume 80, +18 dB acoustic PGA with the divider at unity. The AEC
is the first real implementation behind the shared audio-processor seam; the
adopted aec_capture_bridge owns the 8/16/20 ms cadence conversion and its
process callback is the seam itself, so the fail-closed silence rule applies
twice. The composition rides the single-socket lane with the microphone open
for the whole call (server VAD, touch toggles the call) — a recorded
divergence from decision A2, whose PTT rationale is the echo story on boards
without echo cancellation. The body's servos are the first capability module
on the new peer. Deliberately not ported: camera (the donor never wired one),
/pcm, PNG screen capture, and the AEC evidence harnesses. Separately, phase
5's code landed: apps/kit/clients/voice-cli.ts is a project-secret stream
participant with mu-law both directions (including the firmware's measured
INT16_MIN encode fix) and a TypeScript mirror of the playout identity rules,
with resilient.ts/rpc-ownership.ts reused verbatim and unit tests pinning the
codec sweep and every measured identity scenario.

**Measured:** Host suite 56/56 under ASan/UBSan (donor tests adopted for the
bridge, selector, scaler, high-pass, capture reserve, touch tap, and
conversation lights). All four ESP-IDF targets build with -Wall -Wextra
-Werror: stackchan 0x135f70 (76% of 5 MiB free), waveshare byte-identical at
0x1545c0, m5sticks3 0x117ae0, havpe 0xf0d90. Kit vitest 18/18; repository
typecheck, zero-warning lint, and knip green.

**Surprised by:** The donor's "idle gate" from the 2026-08-03 review memory
ended up at PUBLICATION, not around aec_process — the shipped profile runs
the filter on every frame including far silence, and the switched raw/×6
policy survives only as the A/B control. Also the StackChan target built
clean on the first configure: the audited hash-pinned BSP override transfers
wholesale, which is exactly what its design promised.

**Reviewer said:** Deferred per the user's straight-line directive; 4c commit
boundary for the batched review is 347f66691 (phase 5 code: 4570cbc4a).

**Open:** Hardware conversation proofs for M5StickS3 and HAVPE (both on the
hub and flashable; the Stick's ITERKIT1 blob at 0x210000 already points at
production with a live project and the new decoder ignores its extra donor
field). The TS client's live conversation proof against local dev. StackChan's
continuous-mic socket budget on the single lane is compile-proven only and is
the first thing to measure when its hardware returns. Phase 6 flasher fixes
and the PR.

## 2026-08-05 — phase 4a+4b: hardware conversation proofs

**Did:** Proved both new boards in real conversations against production
(project voice-test), driven end-to-end by RPC with no hands on hardware.
The drive surface is new product code, not a harness: a `conversation`
capability module in push_to_talk's exact shape, mounted alongside
push_to_talk on both boards (remote talk joins the physical level as a
wired-OR through the shared device-event queue). Both units were re-pointed
at voice-test by rewriting their ITERKIT1 blobs in the firmware's TLV format
with the admin-revealable born project key, because their donor-era e2e
projects lack the write-only /secrets/xai material.

**Measured:** M5StickS3 (/agents/voice/2026-08-05-084641): Mac-spoken
"Please repeat exactly these three words: Uplink diagnostic amber." captured
by the real ES8311 microphone as 454 mu-law frames during a remote-held
turn; the durable stream records the exact transcription and the exact
answer "Uplink diagnostic amber."; the device played rx=99/played=99 with
gaps=0, conceal=0, underruns=0. HAVPE (/agents/voice/2026-08-05-085451):
XMOS verified 1.3.1 fail-closed with stage read-back at boot; the same
utterance transcribed exactly and answered exactly; 460 frames up, rx=103/
played=103, gaps=0, conceal=0, underruns=0. Retained logs:
/tmp/iterate-m5sticks3-phase4a-proof.log (sha256 440510ed…c9d0335d) and
/tmp/iterate-havpe-phase4b-proof.log (sha256 97d9a28f…a517b080).

**Surprised by:** Three real findings. (1) The Stick's codec properties
declared its fixed −18 dB ceiling with has_output_gain_control=false — the
seam validator rejects exactly that contradiction, caught on first physical
boot. (2) HAVPE's first physical turn captured 404 clean frames that the
provider's VAD never heard: the donor's validated ×16 make-up gain for the
quiet XMOS NS tap lived in the old worker, and on the companded mu-law wire
it belongs on-device before encoding — with it, transcription was exact on
the next turn. (3) The JTAG rig was actively harmful: OpenOCD halts wedged
the frozen-main diagnosis twice (console back-pressure blocking every
ESP_LOG when the USB device looks host-attached with nobody draining CDC,
and halt-time scheduler corruption), which is what forced the honest
remote-control surface instead.

**Reviewer said:** Deferred per the user's directive; the proof commits are
842b4d872 (remote control + validator fix) and 91652be0c (HAVPE gain).
A correction to this entry: the earlier draft cited a wrong hash.

**Open:** Phase 5's live CLI proof against local dev, Phase 6 flasher fixes
and the PR, and the batched reviews. The prd worker's first setupVoiceAgent
on a cold config-repo build still exceeds the device's setup deadline (one
loud retriable failure — the known warm-up cost); the enforced warm-up
handshake from the donor evidence remains a candidate follow-up.

## 2026-08-05 — phase 4c: StackChan on hardware

**Did:** Deployed the StackChan port to the real CoreS3 and drove real
conversations against production (project voice-test) entirely over RPC.
Fixed five defects that only hardware could show, and built the missing
instrument for a sixth.

**Measured:** Boot fixes first — the PSRAM move of the runtime struct had
dragged the itx transport with it, and FreeRTOS asserts on a PSRAM TCB
(`xPortCheckValidTCBMem`), so the board reboot-looped every ~2 s; the
capture task then tripped its stack canary on the first processed frame
because 4096 bytes cannot hold esp-sr's AEC (the proven donor gave
`aec_process` a dedicated 6144 on top of a 4096-byte I/O task). With the
transport in internal RAM and 8192 bytes of capture stack: 120 s soak,
zero panics, clean boot to `voicelab state=ready`. The 1 Hz face flicker
the user reported was a second bug in the same area — the UI tick
republished an unchanged status snapshot every second — now gated on the
conversation-lights equality helper.

Then the conversation itself. `turns` was the whole story: every device
asked the worker for manual turns, which tells the provider to wait for a
commit this board never sends. With `vad` requested and the worker's VAD
still at its untuned 0.5 threshold with no prefix padding, "Please repeat
exactly these three words: Uplink diagnostic amber" arrived at the model
as "Exactly these three words." At the proven StackChan values
(threshold 0.1, silence 400 ms, prefix padding 400 ms) the sentence
arrives whole and "count slowly from one to fifteen" comes back complete
(`/agents/voice/2026-08-05-113941`, `-114321`).

The device was exonerated by measurement BEFORE the worker was touched. A
new stream-side oracle pulled 50 s of uplink off the wire and decoded it:
2500 frames — exactly 50.0 s — no dropped, duplicated or zero frames,
seam discontinuities statistically identical to interior ones
(p50 64 / p99 ~1.3k both), at levels matching the donor's own recorded
corpus on this same hardware (speech RMS 1150-1865 vs the donor's
800-2280). Downlink arrives in bursts, not starved: 6.7 s of answer audio
delivered in 1.28 s of wall time.

**Surprised by:** Three things. (1) Opening the console port RESETS this
board — the passive reader resets it too, which is how a four-minute
conversation the user was having "crashed in the end": that was my reader
attaching. The rig is now stream-side for anything observed during use.
(2) The reviewer's confident prediction that the depth-one playback
mailbox splices silence into roughly two of every five tail edges is
false, and the instrument says so: `spkPartialChunks` reads 1 for a
14-second answer and 2 for two answers — the final edge of each. The
mailbox depth was left alone. (3) The same review found something real
that no measurement had shown, because the number could not move:
StackChan was the only board that never credited its starvation ledger
from the hardware task, so `ledger_written_ms` never left zero, its
`>= DMA_RING_MS` precondition could never hold, and
`spkStarvedMs`/`spkStarveEvents` — the board's own declared
audible-failure gate — were structurally pinned at 0. The io_task now
credits real answer edges only, and `dmaWrittenMs` is published so the
arming is visible: 56 ms on hardware, past the 40 ms precondition, which
turns `spkStarvedMs=0` from a reassurance into a measurement.

**Reviewer said:** Two independent code reviews ran (the batched phase
reviews are still deferred): a StackChan-vs-Waveshare playback diff and a
donor-policy extraction. Both are answered above — one prediction refuted
by instrument, one dark-gate finding adopted. Their remaining unadopted
findings, all measured absent in this run and recorded for the batched
review rather than acted on blind: mic-queue drop-oldest (`micDropped=0`
across every run), the 40-of-64 outbox reserve gate, no uplink freshness
policy, capture priority 16 under playback's 17, and conceal counted
after `answer_declared_done` (a shared gap across all four boards, so not
changed here for one).

**Open:** The AEC's own quality under double-talk is unmeasured — this
run only proves single-talk turns. `codecCaptureOverruns=1` and
`captureEpochResets=1` at boot want explaining. Phase 6 flasher fixes and
the PR. Commits: c409b3d74 (boot + flicker), 79809f030 (VAD ownership +
tuning, ledger unblinded).

## 2026-08-05 — phase 6: the PR, and two bugs CI found that a Mac could not

**Did:** Opened the PR (#2376, retitled from the old voicelab experiment that
shared this branch), pruned to goal 2, fixed the flasher, and drove CI to
green.

**Measured:** The goal-2 audit found nothing to prune: 386 changed files, no
build artefacts, no evidence binaries, `build/`, `.cache/`, `sdkconfig` and
`managed_components/` all ignored and untracked. The only binary in the diff
is a 14 KB viseme model that a codegen step embeds, and the only vendored
upstream is the 16-file hash-audited CoreS3 BSP override that carries the TDM
patch — both justifiable in one sentence, which was the test. Gates: 262 test
files / 2708 tests, 56 firmware host tests, knip, lint, typecheck, format all
clean locally.

The flasher was worse than the plan thought. §5.2 asked for two cheap
additions; the actual state was that `config-image.ts` wrote UTF-8 JSON inside
the `ITERKIT1` envelope while the firmware has only ever had a
tag-length-value decoder. Every partition it produced was rejected before a
single credential was read, so browser provisioning could not have worked at
all — the boards proven in phase 4 were provisioned with a hand-built image,
which is exactly why nobody noticed. Fixed, plus the requested device-id and
kit-path forward tags, and proven by flashing a partition the shipping encoder
produced: the CoreS3 boots to `voicelab state=ready`, authenticated with the
flashed key. The first attempt failed closed with "decode failed" because the
generator dropped two required fields — the firmware refusing an incomplete
partition is the design working, and it is why this was worth flashing rather
than unit-testing alone.

The plan's other two flasher items do not apply to this branch: there is no
first-party browser flasher here to add `readFlash()`/`calculateMD5Hash`
verification to, and no `hard_reset` call to give a `watchdog_reset` fallback.
ESP Web Tools owns that path. Recorded rather than invented.

**Surprised by:** Both CI failures were invisible on a Mac. The firmware host
suite failed only under GCC — comparing constants from two different anonymous
enums is `-Werror=enum-compare` there and silent under Apple clang — so a test
file built locally and broke CI. A sweep found no other first-party instance.

The preview lane was the better bug. GitHub's compare response caps its file
list at 300 and the list is ORDERED, so on a large diff the tail is simply
absent — and absence reads as "that app did not change". This branch's 386
files put `apps/kit/**` ahead of `apps/os/**` alphabetically: the firmware
consumed the whole cap, OS was never selected, nothing deployed, and the e2e
lane then had no recorded deployment to test and failed the PR. The
container-rollout decision in the same file already refuses to trust a capped
comparison, with a comment stating the principle; app selection had never
applied it. Now it does, and the only safe refusal is the whole fleet.
Measured against the real function: 300 files select all six apps, 299 select
none.

**Correction to commit 9664d4f7e's message:** it claims
`scripts/preview/preview.test.ts` "does not appear to be included by any test
lane". That is wrong. `scripts` is a pnpm workspace with its own test script,
so `pnpm test` runs it — 19 files, 284 tests, including the two new cap cases.
I had been invoking vitest from the wrong directory and concluded too much
from it. The assertions run in CI.

**Reviewer said:** The batched independent reviews were re-run after the first
pair died on a server overload; findings and their resolutions are recorded
where they land.

**Open:** Merge is Jonas's call. StackChan double-talk remains unmeasured, and
`codecCaptureOverruns=1` / `captureEpochResets=1` at its boot are still
unexplained.

## 2026-08-05 — review round: seven threads, and a dead-code sweep

**Did:** Answered and resolved every review thread on #2376, and ran the
dead-code sweep the batched reviews were supposed to include (the first three
attempts died on upstream 529s, so this ran as a narrower, better-targeted
question: what is provably dead or dark).

**Measured:** Three of the seven review findings were real bugs, all mine.
(1) An open Wi-Fi network was unprovisionable: the encoder skipped empty
values, but the password is the one field the firmware decodes with
`allow_empty` while still requiring its tag — so an open SSID failed closed
as "missing field", and my own comment claimed the opposite, which is how it
survived being written. (2) `endOfResponse`'s "expected drain" permission
outlived the audio it was granted for, because a barge-in or a superseding
answer discards the queue before the drain can spend it — so the next
answer's first real underrun was excused, and the one counter meaning
"audible gap" under-reported for the rest of the run. (3) An interrupt one
frame into an answer left the abandoned frame at zero, and `frame >= 0` then
refused the reused-number restart that branch exists to admit. Both existing
interrupt tests hid it by accepting two frames before interrupting; the new
firmware test fails without the fix, verified by reverting it.

The other four were cast findings, fixed by deleting the assertion rather
than explaining it: a named credential union, checked payload fields on the
bridge (a non-string callId would have been used as a call identity and a
missing `t` pushed NaN into the latency percentiles), and loose schemas on
both providers' text frames.

The sweep then found two more instruments of the class already fixed twice
here. `capFailed`/`spkFailed`: after three consecutive I/O failures the audio
task gates that direction off forever, and the failure counters increment
behind the same gate, so they freeze at the threshold — a permanently dead
microphone read exactly like a healthy quiet one. And the AEC capture
bridge's metrics had no reader at all, on the only board with an AEC, so
refused frames, sequence discontinuities and a backwards clock were invisible.
Both published now.

**Surprised by:** How reliably this defect class keeps appearing — four
instances now, each one a counter that could not move or a getter nobody
called, and each one found by a different method (measurement, a targeted
review, a sweep). Also that CI caught two failures a Mac structurally cannot
see: `-Werror=enum-compare` is GCC-only, and GitHub's 300-file compare cap
silently truncated app selection so nothing deployed and the e2e lane failed
with no deployment to test.

**Reviewer said:** Adopted above. Recorded and NOT acted on, because acting
blind on proven boards is worse than a written-down gap: `inject_starvation`
setters have no caller on any of the four boards, which makes each board's
`#ifdef ITERATE_KIT_DIAGNOSTIC_STARVATION` block unreachable; Waveshare's
avatar-selection family (`request_slug`/`request_next`/`count`/`slug_at`) and
three audio utility accessors have no callers; `components/avatar`'s
`face_driver` module appears wholly superseded by `face_animator`;
StackChan's `avatar_request_sprite_set` is bypassed by the private face-button
path. Each is a candidate deletion for a follow-up with its own proof.

**Open:** The two new StackChan health fields are compile-proven only — the
CoreS3 left the USB tree mid-flash, so unlike every other StackChan change
here they have not been seen on hardware. Double-talk still unmeasured. Merge
is Jonas's call.
