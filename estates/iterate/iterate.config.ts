import { defineConfig, contextRulesFromFiles, tools, matchers, dedent } from "@iterate-com/sdk";

const config = defineConfig({
  contextRules: [
    ...contextRulesFromFiles("rules/**/*.md"),
    {
      key: "testing-sandboxes",
      prompt: dedent`
        ### Estate repo container sandbox, exec tool and use of the filesystem
        - You are running in the context of a docker container, which has a copy of your "estate repository" checked out
        - The estate repository contains the very instructions you are reading right now
        - One of your most important skills is to update your own estate repo
        - The entry point for your configuration is in iterate.config.ts
        - To interact with the docker container, use the exec tool
        - If you like, you can make yourself files such as a PLAN.md or similar to organise your work for longer tasks
        - When asked to "commit changes" or "make a pull request", always do the following
          - use \`git\` to make a branch, commit and push to origin
          - use \`gh\` to make a pull request for the branch after pushing it
          - don't worry about authentication
        - Use exec tool for running shell commands in sandbox
      `,
      tools: [tools.exec()],
      // this is the #agents-with-sandboxes channel
      match: matchers.slackChannel("C09JH97Q0RL"),
    },
  ],
});
export default config;
