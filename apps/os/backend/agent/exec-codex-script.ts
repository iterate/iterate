export function buildExecCodexResumeScript({
  instructionsFilePath,
  codexFlags = ["--json", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check"],
  logPrefix = "[execCodex]",
}: {
  instructionsFilePath: string;
  codexFlags?: string[];
  logPrefix?: string;
}): string {
  const baseCommand = ["codex", "exec", ...codexFlags].join(" ").trim();
  const prompt = `Perform the task described in ${instructionsFilePath}`;

  return [
    "#!/bin/bash",
    "set -uo pipefail",
    "",
    `PROMPT="${prompt.replace(/"/g, '\\"')}"`,
    `BASE_COMMAND=(${baseCommand})`,
    `echo "${logPrefix} Attempting to resume Codex session" >&2`,
    'if "${BASE_COMMAND[@]}" resume --last - <<< "$PROMPT"; then',
    "  exit 0",
    "fi",
    "",
    "resume_status=$?",
    `echo "${logPrefix} Resume failed with status \${resume_status}; starting a new session" >&2`,
    'exec "${BASE_COMMAND[@]}" - <<< "$PROMPT"',
    "",
  ].join("\n");
}
