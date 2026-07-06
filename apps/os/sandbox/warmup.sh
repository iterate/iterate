#!/usr/bin/env bash
# Iterate sandbox warmup — runs INSIDE the container during provisioning (in
# the background, overlapping the repo clone/restore, after the env map is
# applied). Baked into the image at /opt/iterate/warmup.sh; the sandbox
# Durable Object execs it and emits `sandbox/warmed-up` on exit 0 or
# `sandbox/warmup-failed` otherwise, so the start→restore→warmup saga is
# visible on the sandbox's stream. Not a Dockerfile CMD: a CMD runs before
# the Durable Object applies the env-var map (the getSecret placeholders the
# steps need) and has no way to report into the stream.
#
# Step contract: a step whose PRECONDITION is missing (tool not baked, no key
# configured) SKIPS as success — the sandbox is fine, the tool just surfaces
# its own auth error if used. A step that was expected to work and didn't
# reports to stderr and flips `failed`, so the DO emits warmup-failed with the
# reason instead of claiming the tools are ready. Never exit early: later
# steps still run.
set -u
failed=0

# Codex: log in with OPENAI_API_KEY (a getSecret placeholder substituted only
# at egress) so `codex exec` works with no per-command login line. Codex 0.142
# won't use the env key directly; this one-time login writes ~/.codex/auth.json
# (ephemeral disk, hence per-container warmup).
if command -v codex >/dev/null 2>&1 && [ -n "${OPENAI_API_KEY:-}" ]; then
  if printf %s "$OPENAI_API_KEY" | timeout 120 codex login --with-api-key >/dev/null; then
    echo "codex: logged in"
  else
    echo "codex: login failed (is the project's OpenAI secret valid?)" >&2
    failed=1
  fi
else
  echo "codex: skipped (not installed or no OPENAI_API_KEY)"
fi

echo "warmup: done (failed=$failed)"
exit "$failed"
