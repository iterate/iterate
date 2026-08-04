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
