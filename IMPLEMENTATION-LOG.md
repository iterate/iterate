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
