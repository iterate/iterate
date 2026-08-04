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
