import { z } from "zod/v4";
import dedent from "dedent";
import * as yaml from "yaml";
import { SearchRequest } from "../default-tools.ts";
import { tools } from "../../sdk/index.ts";
import type { ContextRule } from "./context-schemas.ts";
import { createDOToolFactory, type DOToolDefinitions } from "./do-tools.ts";
import { iterateAgentTools } from "./iterate-agent-tools.ts";
import { IterateAgent } from "./iterate-agent.ts";
import type { CoreAgentSlices, IterateAgentState } from "./iterate-agent.ts";
import { onboardingAgentTools } from "./onboarding-agent-tools.ts";
import { startSlackAgentInChannel } from "./start-slack-agent-in-channel.ts";
import { matchers } from "./context.ts";

type ToolsInterface = typeof onboardingAgentTools.$infer.interface;
type Inputs = typeof onboardingAgentTools.$infer.inputTypes;

export const OnboardingData = z.object({
  researchResults: z.record(z.string(), z.unknown()).optional(),
});

export type OnboardingData = z.infer<typeof OnboardingData>;

type OnboardingAgentState = IterateAgentState & {
  onboardingData?: OnboardingData;
  ashsStuffRan?: boolean;
};

export class OnboardingAgent
  extends IterateAgent<CoreAgentSlices, OnboardingAgentState>
  implements ToolsInterface
{
  toolDefinitions(): DOToolDefinitions<{}> {
    return {
      ...super.toolDefinitions(),
      ...onboardingAgentTools,
    };
  }

  protected async getContextRules(): Promise<ContextRule[]> {
    // We just start with a completely blank slate here and don't
    // pull in anything from iterate config. Want to have maximum control.
    const iterateAgentTool = createDOToolFactory(iterateAgentTools);
    const onboardingAgentTool = createDOToolFactory(onboardingAgentTools);
    return [
      {
        key: "onboarding-agent",
        prompt: dedent`
          Your job is to take an email address and research as much as possible about the company it represents.

          For example, if I give you somebody@iterate.com, you should visit their website, google "somebody iterate.com", try to find social media profiles, etc etc

          Each time you learn something, call updateResults with the new information.
        `,
        tools: [
          iterateAgentTool.doNothing({
            overrideName: "endTurn",
            overrideDescription: "End your turn and do nothing else",
          }),
          // iterateAgentTool.connectMCPServer(),
          // iterateAgentTool.getAgentDebugURL(),
          // iterateAgentTool.remindMyselfLater(),
          // iterateAgentTool.listMyReminders(),
          // iterateAgentTool.cancelReminder(),
          iterateAgentTool.getURLContent(),
          iterateAgentTool.searchWeb({
            overrideInputJSONSchema: z.toJSONSchema(
              SearchRequest.pick({
                query: true,
              }),
            ),
          }),
          // iterateAgentTool.generateImage(),
          // iterateAgentTool.generateVideo(),
          onboardingAgentTool.updateResults(),
          onboardingAgentTool.getResults(),
        ],
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
          - after edits: git status -sb; nl -ba file | sed -n to inspect exact lines that changed
          - branch flow: git checkout -b <branch-name>; git add -A; git commit; git push -u origin <branch-name>
          - if gh pr create fails, check branch exists remotely (gh pr list --head); push first
          - following running codex tools, give the user a summary of what codex did, espescially decisions codex made and issues it found. Then an update with next steps for the user.git
        `,
        tools: [tools.execCodex(), tools.exec()],
        match: matchers.always(), // slackChannel("#general"),
      },
    ];
  }

  override async onStart(): Promise<void> {
    await super.onStart();

    // Ash: if you add something here, it'll kick off every time the durable object boots
    if (!this.state.ashsStuffRan) {
      this.ctx.waitUntil(
        (async () => {
          // Run your agent here
          this.setState({
            ...this.state,
            ashsStuffRan: true,
          });
        })(),
      );
    }

    if (!this.state.onboardingData) {
      this.setState({
        ...this.state,
        onboardingData: {},
      });
      this.agentCore.addEvents([
        {
          type: "CORE:SET_MODEL_OPTS",
          data: {
            model: "gpt-5",
            toolChoice: "required",
          },
        },
        {
          type: "CORE:LLM_INPUT_ITEM",
          data: {
            type: "message",
            role: "developer",
            content: [
              {
                type: "input_text",
                text: `The email address you can start with is the one from '${this.organization.name}'`,
              },
            ],
          },
          triggerLLMRequest: true,
        },
      ]);
    }
  }

  private mergeResults(results: Record<string, any>): void {
    const currentOnboardingData = this.state.onboardingData ?? {};
    const currentResearchResults = currentOnboardingData.researchResults ?? {};
    this.setState({
      ...this.state,
      onboardingData: {
        ...currentOnboardingData,
        researchResults: {
          ...currentResearchResults,
          ...results,
        },
      },
    });
  }

  private getResearchResults(): Record<string, any> {
    return (this.state.onboardingData?.researchResults ?? {}) as Record<string, any>;
  }

  async updateResults(input: Inputs["updateResults"]) {
    this.mergeResults(input.results);
    return {};
  }

  async getResults(_input: Inputs["getResults"]) {
    return this.getResearchResults();
  }

  async startSlackThread(input: { channel: string; firstMessage?: string }) {
    const { channel, firstMessage } = input;

    return await startSlackAgentInChannel({
      db: this.db,
      estateId: this.databaseRecord.estateId,
      slackChannelIdOrName: channel,
      firstMessage: firstMessage,
    });
  }

  // This is autoamtically pulled into context of all SlackAgents
  async onboardingPromptFragment() {
    return `
      You are in "onboarding" mode. Try to impress the user by casually working some of the following facts into any conversation.

      But only if it feels natural. You're trying to impress them with your "inside knowledge", but without them knowing that you're trying.

      It's okay to be a bit cheeky.

      Here's the research about your user:

      ${yaml.stringify(this.getResearchResults())}
    `;
  }
}
