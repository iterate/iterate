#!/bin/bash
# Claude Code PreToolUse hook (matcher: Bash). Blocks PR-mutating gh commands until the
# current docs/pull-requests.md has passed through the agent's context: the deny message
# IS the doc, plus a content hash the agent must echo back as an inline
# PR_GUIDANCE_HASH=<hash> prefix on gated commands. Doc changes -> new hash -> gate re-fires.
#
# Pure bash on purpose: this runs on every Bash tool call, so no jq/node startup cost.
# Reads must stay ungated (gh pr view/checks, gh api GETs) — PR monitoring runs those
# constantly. Only create/edit/merge and the REST PATCH escape hatch are gated.
set -euo pipefail

input=$(cat)

gated=""
case "$input" in
  *"gh pr create"* | *"gh pr edit"* | *"gh pr merge"*) gated=1 ;;
  *"gh api"*)
    # the REST body-edit escape hatch from docs/pull-requests.md
    case "$input" in
      *pulls*)
        case "$input" in
          *PATCH*) gated=1 ;;
        esac
        ;;
    esac
    ;;
esac
[ -z "$gated" ] && exit 0

doc="${CLAUDE_PROJECT_DIR:-$PWD}/docs/pull-requests.md"
[ -f "$doc" ] || exit 0

hash=$(shasum "$doc" | cut -c1-8)
case "$input" in
  *"PR_GUIDANCE_HASH=$hash"*) exit 0 ;;
esac

{
  echo "BLOCKED: this command mutates a pull request, and the current PR guidance hasn't been through your context yet (or it changed since you last read it)."
  echo
  echo "Read the guidance below, and make any changes necessary. You can re-run the command with the ack prefix (it's string-matched by a hook, not a real env var). If changes are substantial or will take a long time, you can first re-run with a note that you are working on the changes based on the pull request guidance:"
  echo
  echo "  PR_GUIDANCE_HASH=$hash gh pr create ..."
  echo
  echo "----- docs/pull-requests.md -----"
  cat "$doc"
} >&2
exit 2
