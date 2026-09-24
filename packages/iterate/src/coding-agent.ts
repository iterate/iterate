/**
 * Whether a coding agent, not a person, is running this process. The one list of agent markers for
 * the iterate CLI (no browser opens, no prompts), lint-staged.config.cjs (typecheck, test and lint on
 * every commit) and .husky/prepare-commit-msg (no `git commit --amend`). The last two load this file
 * with Node's own type stripping, so it stays import-free erasable TypeScript.
 *
 * - Claude Code sets CLAUDE_CODE_CHILD_SESSION=1 in its tool, hook and status-line subprocesses
 *   (v2.1.172 and later). Not CLAUDECODE: Claude Code's IDE extensions also set that in the
 *   integrated terminal a person types into. https://code.claude.com/docs/en/env-vars
 * - OpenCode sets OPENCODE=1 and OPENCODE_SESSION.
 * - AGENT=1 is the generic marker for other agents.
 */
export function isCodingAgent(env: Record<string, string | undefined>) {
  return (
    env.CLAUDE_CODE_CHILD_SESSION === "1" ||
    env.OPENCODE === "1" ||
    Boolean(env.OPENCODE_SESSION) ||
    env.AGENT === "1"
  );
}
