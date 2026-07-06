#!/usr/bin/env bash
# Iterate sandbox warmup — runs INSIDE the container during provisioning (in the
# background, after the env map is applied and while the repo clone/restore
# finishes). Best-effort: every step is optional and warmup must never hard-fail
# the sandbox, so failures are reported and swallowed. Baked into the image at
# /opt/iterate/warmup.sh (see apps/os/sandbox/Dockerfile); the sandbox Durable
# Object runs it and emits `sandbox/warmed-up` (or `warmup-failed`) so the whole
# start→restore→warmup saga is visible on the sandbox's stream.
set -u

# Codex: log in with OPENAI_API_KEY (a getSecret placeholder substituted only at
# egress) so `codex exec` works with no per-command login line. Codex 0.142
# won't use the env key directly; this one-time login writes ~/.codex/auth.json.
if command -v codex >/dev/null 2>&1 && [ -n "${OPENAI_API_KEY:-}" ]; then
  if printf %s "$OPENAI_API_KEY" | codex login --with-api-key >/dev/null 2>&1; then
    echo "codex: logged in"
  else
    echo "codex: login failed (is a project OpenAI secret set?)"
  fi
else
  echo "codex: skipped (not installed or no OPENAI_API_KEY)"
fi

echo "warmup: done"
