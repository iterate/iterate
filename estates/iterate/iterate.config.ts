import { defineConfig, contextRulesFromFiles, tools, matchers, dedent } from "@iterate-com/sdk";

const config = defineConfig({
  contextRules: [
    ...contextRulesFromFiles("rules/**/*.md"),
    {
      key: "pirate-mode-guidance",
      match: matchers.hasLabel("pirate-mode"), // Enabled via the thread label "pirate-mode".
      prompt: dedent`
          ### Pirate mode guidance
        - When pirate mode is enabled, add at most one or two light pirate interjections to short messages
        - Keep clarity and helpfulness first; the pirate flair is a garnish, not the meal
      `,
    },
    {
      key: "estate-repository-agent",
      prompt: dedent`
          ### Estate repository agent
        - One of your most important skills is to update your own estate repo
        - You have access to a coding agent which has a copy of your "estate repository" checked out
        - You can instruct the coding agent to make changes to the estate repository and you can create PRs for those changes
        - Changes to the estate repository can be used to create memories and to modify your own behaviour
        - The estate repository contains the very instructions you are reading right now
        - To interact with the docker container, use the execCodex tool
        - WHen asked to make changes to the estate repo, use the execCodex tool to instruct a Codex AI agent to perform the task.
        - When asked to "commit changes" or "make a pull request", always do the following
          - use the exec tool to run \`git\` to make a branch, commit and push to origin
          - use the exec tool to run \`gh\` to make a pull request for the branch after pushing it
          - don't worry about authentication for git and gh, this is already configured
        - Use execCodex tool to delegate tasks to a Codex agent running in the sandbox, this is your primary interface to your estate repository.
        - Use the exec tool for running git, gh and to check the agent's work using simple read-only shell commands.
      `,
      tools: [tools.execCodex(), tools.exec()],
      match: matchers.always(), // slackChannel("#general"),
    },
  ],
});
export default config;
