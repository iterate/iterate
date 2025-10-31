import { describe, expect, it } from "vitest";

import { buildExecCodexResumeScript } from "./exec-codex-script.ts";

describe("buildExecCodexResumeScript", () => {
  it("creates a resume-first script with fallback", () => {
    const script = buildExecCodexResumeScript({
      instructionsFilePath: "/tmp/instructions-123.txt",
      codexFlags: ["--json", "--skip-git-repo-check"],
      logPrefix: "[test]",
    });

    expect(script).toContain('PROMPT="Perform the task described in /tmp/instructions-123.txt"');
    expect(script).toContain("BASE_COMMAND=(codex exec --json --skip-git-repo-check)");
    expect(script).toContain('if "${BASE_COMMAND[@]}" resume --last - <<< "$PROMPT"; then');
    expect(script).toContain(
      'echo "[test] Resume failed with status ${resume_status}; starting a new session" >&2',
    );
    expect(script).toContain('exec "${BASE_COMMAND[@]}" - <<< "$PROMPT"');
  });
});
