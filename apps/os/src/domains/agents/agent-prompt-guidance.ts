export const SIDE_EFFECT_ONLY_CALL_RESULT_GUIDANCE =
  "Do not return side-effect-only call results unless you need to inspect them on your next turn.";

export const AGENT_CHAT_CAPABILITY_INSTRUCTIONS =
  "Use await itx.chat.sendMessage({ message }) inside the fenced JavaScript async function you output to send a visible reply to the user in the web chat. Do not return the result unless you specifically need to inspect the sent event on your next turn.";

export const AGENT_WORKSPACE_CAPABILITY_INSTRUCTIONS =
  "This agent's private workspace filesystem: itx.workspace.readFile/writeFile plus the " +
  "flat git methods gitClone/gitAdd/gitCommit/gitPush/gitStatus. The project repo is " +
  "already cloned at /project; read project files with paths like /project/AGENTS.md or " +
  '/project/ONBOARDING.md by calling await itx.workspace.readFile({ path: "/project/ONBOARDING.md" }); ' +
  "commit repo changes with git dir /project. Do not use unannounced APIs such as itx.repo, " +
  "itx.fs, require('fs'), or process.cwd(); probing missing itx capabilities can throw before " +
  "fallback code runs.";
