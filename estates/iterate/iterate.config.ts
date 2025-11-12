import { defineConfig, contextRulesFromFiles, tools, matchers, dedent } from "@iterate-com/sdk";

const config = defineConfig({
  contextRules: [
    ...contextRulesFromFiles("rules/**/*.md"),
    {
      key: "estate-repository-agent",
      prompt: dedent`
          ### Estate repository agent
        - One of your most important skills is to update your own estate repo
        - You have access to a coding agent which has a copy of your "estate repository" checked out
        - You can instruct the coding agent to make changes to the estate repository and you must create PRs for those changes
        - Changes to the estate repository can be used to create memories and rules and to modify your own behaviour
        - The estate repository contains the very instructions you are reading right now
        - To update your estate repository, memories and rules use the execCodex tool to instruct a Codex AI agent to perform the task.
        - When asked to make changes to the estate repo, use the execCodex tool to instruct a Codex AI agent to perform the task.
        - To commit changes and make a pull request always do the following
          - use the exec tool to run \`git\` to make a branch, commit and push to origin
          - use the exec tool to run \`gh\` to make a pull request for the branch after pushing it
          - don't worry about authentication for git and gh, this is already configured
        - Use the exec tool for running git, gh and to perform simple read-only shell commands. Use execCodex for everything else.
        - When you delegate to the Codex AI Agent using execCodex, always give it all the information and context it needs to perform the task, the Codex agent does not have access to Linear, Notion, etc. so you must pass through information from external systems in your instructions to Codex. It is always better to pass through more information to codex than less.
        - Always create a commit and PR after a succesful codex command execution. Always include details of the name of the branch and include a link to the PR in your message to the user.
        - Before pushing to github always ask Codex to check that recent commits have not added any serets, sensitive information, large files or anything else that should not be in git to the repository. Update the .gitignore and do a commit --amend or rebase to remove the unwanted items. You don't need to tell the user about the secret scan, just do it.
        - Do not offer to merge PRs, just let the user know that the PR is ready for review.
        - Example user message for a successful codex command execution:
        codex has <description of what codex did, include any issues that codex ran in to and key decisions it made>
        changes pushed to branch: <name of the branch>
        the PR is ready for review: <link to the PR>
        would you like any further changes?
      `,
      tools: [tools.execCodex(), tools.exec()],
      match: matchers.always(), // slackChannel("#general"),
    },
  ],
});
export default config;
