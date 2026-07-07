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

# git → github.com: when GH_TOKEN is set (a getSecret placeholder for the
# project's GitHub connection, substituted only at egress), send it as a raw
# Bearer extraheader on every github.com HTTPS request. Deliberately NOT a
# credential helper and NOT `gh auth setup-git`: both make git send Basic
# auth — base64(user:token) — which hides the placeholder from the egress
# door's header substitution, so the request would reach GitHub with the
# placeholder still encoded inside it. A raw header keeps the placeholder
# visible for substitution. `gh` itself needs no setup — it reads GH_TOKEN
# from the environment natively.
if [ -n "${GH_TOKEN:-}" ]; then
  if git config --global http."https://github.com/".extraheader "AUTHORIZATION: Bearer $GH_TOKEN"; then
    echo "git: github.com auth header configured"
  else
    echo "git: configuring github.com auth header failed" >&2
    failed=1
  fi
else
  echo "git: skipped (no GH_TOKEN)"
fi

echo "warmup: done (failed=$failed)"
exit "$failed"
