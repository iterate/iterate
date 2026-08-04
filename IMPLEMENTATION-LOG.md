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
