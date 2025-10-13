import { z } from "zod/v4";
import dedent from "dedent";
import { SearchRequest } from "../default-tools.ts";
import type { ContextRule } from "./context-schemas.ts";
import { createDOToolFactory, type DOToolDefinitions } from "./do-tools.ts";
import { iterateAgentTools } from "./iterate-agent-tools.ts";
import { IterateAgent } from "./iterate-agent.ts";
import type { CoreAgentSlices, IterateAgentState } from "./iterate-agent.ts";
import { onboardingAgentTools } from "./onboarding-agent-tools.ts";
import { startSlackAgentInChannel } from "./start-slack-agent-in-channel.ts";

type ToolsInterface = typeof onboardingAgentTools.$infer.interface;
type Inputs = typeof onboardingAgentTools.$infer.inputTypes;

// Company context gathered by stalking agent
const CompanyContext = z.object({
  company: z.object({
    name: z.string(),
    domain: z.string(),
    description: z.string().nullish(),
    tagline: z.string().nullish(),
    founded: z.string().nullish(),
    location: z.object({
      city: z.string().nullish(),
      state: z.string().nullish(),
      country: z.string().nullish(),
      fullAddress: z.string().nullish(),
    }).nullish(),
    teamSize: z.string().nullish(),
    industry: z.string().nullish(),
    stage: z.string().nullish(),
  }),
  branding: z.object({
    logoUrl: z.string().nullish(),
    colors: z.object({
      primary: z.string().nullish(),
      secondary: z.string().nullish(),
      accent: z.string().nullish(),
      additional: z.array(z.string()).nullish(),
    }).nullish(),
    fonts: z.object({
      heading: z.string().nullish(),
      body: z.string().nullish(),
    }).nullish(),
    toneOfVoice: z.string().nullish(),
    brandAssets: z.array(z.string()).nullish(),
  }).nullish(),
  targetCustomers: z.object({
    description: z.string().nullish(),
    segments: z.array(z.string()).nullish(),
  }).nullish(),
  products: z.array(z.object({
    name: z.string(),
    description: z.string(),
    url: z.string().nullish(),
  })).nullish(),
  funding: z.object({
    totalRaised: z.string().nullish(),
    lastRound: z.object({
      type: z.string().nullish(),
      amount: z.string().nullish(),
      date: z.string().nullish(),
      investors: z.array(z.string()).nullish(),
    }).nullish(),
  }).nullish(),
  competitors: z.array(z.object({
    name: z.string(),
    url: z.string().nullish(),
  })).nullish(),
  metadata: z.object({
    scrapedAt: z.string(),
    confidence: z.enum(["high", "medium", "low"]).nullish(),
    notes: z.string().nullish(),
  }).nullish(),
}).nullish();

const OnboardingChecklist = z.object({
  firstToolConnected: z.boolean().default(false),
  remoteMCPConnected: z.boolean().default(false),
  learnedBotUsageEverywhere: z.boolean().default(false),
  removedOnboardingRules: z.boolean().default(false),
  stripeConnected: z.boolean().default(false),
  communityInviteSent: z.boolean().default(false),
}).default({
  firstToolConnected: false,
  remoteMCPConnected: false,
  learnedBotUsageEverywhere: false,
  removedOnboardingRules: false,
  stripeConnected: false,
  communityInviteSent: false,
});

export const OnboardingData = z.object({
  // Legacy field for backward compatibility
  researchResults: z.record(z.string(), z.unknown()).optional(),
  // New structured company context
  companyContext: CompanyContext,
  // Onboarding progress checklist
  onboardingChecklist: OnboardingChecklist,
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

    // Get the company domain from organization name or extract from user email
    const companyDomain = this.extractCompanyDomain();
    const logoUrl = companyDomain
      ? `https://img.logo.dev/${companyDomain}?token=${this.env.LOGO_DEV_PUBLISHABLE_KEY}&size=512&format=png`
      : null;

    return [
      {
        key: "onboarding-agent",
        prompt: dedent`
          # Company Research Agent

          Your task: Gather comprehensive company information for domain: ${companyDomain || 'NOT YET EXTRACTED'}

          ## Research Strategy

          Use ALL available tools to gather information. Cross-reference and fact-check across multiple sources:

          **searchWeb**: Search for funding, competitors, news, team info, industry context
          **getURLContent**: Visit company website for branding, tone, products, official info
          Run tools in parallel where possible. When sources conflict, prefer official company sources > recent news > third-party data.

          ## What to Extract

          **From Website (${companyDomain || 'company domain'})**:
          - Homepage: name, tagline, value proposition, products, target customers
          - About page: founding year, team size, location, history
          - Tone of Voice: Analyze writing style - is it professional, casual, technical, friendly, authoritative? Describe in 1-2 sentences.
          - Target Customers: Who is the product for? Look for explicit mentions, use cases, testimonials, customer examples.

          **From Research (searchWeb)**:
          - Funding: total raised, last round details, investors
          - Competitors: similar companies in the space
          - Recent news: announcements, milestones, updates
          - Team: employee count, founders, key people
          - Industry and stage information

          **Logo URL**: ${logoUrl || 'Will be generated after domain extraction'}

          ## Data Quality Rules

          - Use null for fields where information is not found
          - Do NOT guess or speculate
          - Cross-reference multiple sources for accuracy
          - Call updateResults with a structured object containing company data

          ## updateResults Format

          Call updateResults with an object matching this structure:
          {
            "company": {
              "name": "string",
              "domain": "${companyDomain || 'domain'}",
              "description": "string (2-3 sentences)",
              "tagline": "string or null",
              "founded": "string (YYYY) or null",
              "location": { "city": "...", "country": "...", ... },
              "teamSize": "string or null",
              "industry": "string or null",
              "stage": "string or null"
            },
            "branding": {
              "logoUrl": "${logoUrl || 'logo url'}",
              "colors": { "primary": "#hex", ... },
              "fonts": { "heading": "...", "body": "..." },
              "toneOfVoice": "description of brand voice",
              "brandAssets": ["urls"]
            },
            "targetCustomers": {
              "description": "who the product/service is for",
              "segments": ["customer segments/personas"]
            },
            "products": [{ "name": "...", "description": "...", "url": "..." }],
            "funding": { "totalRaised": "...", "lastRound": {...} },
            "competitors": [{ "name": "...", "url": "..." }],
            "metadata": {
              "scrapedAt": "${new Date().toISOString()}",
              "confidence": "high|medium|low",
              "notes": "any notes"
            }
          }

          Start by visiting the company website and searching for information about them.
        `,
        tools: [
          iterateAgentTool.doNothing({
            overrideName: "endTurn",
            overrideDescription: "End your turn and do nothing else",
          }),
          iterateAgentTool.getURLContent(),
          iterateAgentTool.searchWeb({
            overrideInputJSONSchema: z.toJSONSchema(
              SearchRequest.pick({
                query: true,
                numResults: true,
                type: true,
                category: true,
              }),
            ),
          }),
          onboardingAgentTool.updateResults(),
          onboardingAgentTool.getResults(),
          onboardingAgentTool.getOnboardingProgress(),
          onboardingAgentTool.updateOnboardingProgress(),
        ],
      },
    ];
  }

  // Extract company domain from organization name or user email
  private extractCompanyDomain(): string | null {
    // Try to extract from organization name first (e.g., "iterate.com" or "Iterate")
    const orgName = this.organization.name;

    // Check if org name is a domain
    if (orgName.includes('.') && !orgName.includes('@')) {
      return orgName.toLowerCase().trim();
    }

    // Check if org name looks like a company name we can convert to domain
    // For now, just return null and we'll extract from email
    // TODO: Could add logic to guess domain from company name (e.g., "Iterate" -> "iterate.com")

    return null;
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
      // Extract company domain for research
      const companyDomain = this.extractCompanyDomain();

      // Initialize onboarding data with empty checklist
      this.setState({
        ...this.state,
        onboardingData: {
          onboardingChecklist: {
            firstToolConnected: false,
            remoteMCPConnected: false,
            learnedBotUsageEverywhere: false,
            removedOnboardingRules: false,
            stripeConnected: false,
            communityInviteSent: false,
          },
        },
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
                text: companyDomain
                  ? `Start company research for domain: ${companyDomain}`
                  : `Start company research for organization: ${this.organization.name}`,
              },
            ],
          },
          triggerLLMRequest: true,
        },
      ]);
    }
  }

  private mergeResults(results: Record<string, any>): void {
    const currentOnboardingData = this.state.onboardingData;
    const currentResearchResults = currentOnboardingData?.researchResults ?? {};
    const currentChecklist = currentOnboardingData?.onboardingChecklist ?? {
      firstToolConnected: false,
      remoteMCPConnected: false,
      learnedBotUsageEverywhere: false,
      removedOnboardingRules: false,
      stripeConnected: false,
      communityInviteSent: false,
    };

    this.setState({
      ...this.state,
      onboardingData: {
        companyContext: currentOnboardingData?.companyContext,
        onboardingChecklist: currentChecklist,
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

  async getOnboardingProgress(_input: Inputs["getOnboardingProgress"]) {
    const checklist = this.state.onboardingData?.onboardingChecklist ?? {
      firstToolConnected: false,
      remoteMCPConnected: false,
      learnedBotUsageEverywhere: false,
      removedOnboardingRules: false,
      stripeConnected: false,
      communityInviteSent: false,
    };
    return { checklist };
  }

  async updateOnboardingProgress(input: Inputs["updateOnboardingProgress"]) {
    const { step, completed } = input;
    const currentOnboardingData = this.state.onboardingData;
    const currentChecklist = currentOnboardingData?.onboardingChecklist ?? {
      firstToolConnected: false,
      remoteMCPConnected: false,
      learnedBotUsageEverywhere: false,
      removedOnboardingRules: false,
      stripeConnected: false,
      communityInviteSent: false,
    };

    const newChecklist = {
      ...currentChecklist,
      [step]: completed,
    };

    this.setState({
      ...this.state,
      onboardingData: {
        companyContext: currentOnboardingData?.companyContext,
        researchResults: currentOnboardingData?.researchResults,
        onboardingChecklist: newChecklist,
      },
    });

    return {
      success: true,
      checklist: newChecklist,
    };
  }

  // This is automatically pulled into context of all SlackAgents
  async onboardingPromptFragment() {
    const companyContext = this.state.onboardingData?.companyContext;
    const checklist = this.state.onboardingData?.onboardingChecklist ?? {
      firstToolConnected: false,
      remoteMCPConnected: false,
      learnedBotUsageEverywhere: false,
      removedOnboardingRules: false,
      stripeConnected: false,
      communityInviteSent: false,
    };

    // Legacy research results (for backward compatibility)
    const legacyResults = this.getResearchResults();
    const hasLegacyData = Object.keys(legacyResults).length > 0;

    return dedent`
      # 🎯 ONBOARDING MODE ACTIVE - PRIORITY INSTRUCTIONS

      You are @iterate in ONBOARDING MODE. Your personality is playful, sassy, and witty.

      ## Company Context
      ${companyContext ? this.formatCompanyContext(companyContext) : hasLegacyData ? `Research in progress:\n${JSON.stringify(legacyResults, null, 2)}` : "Still gathering company intel... 🕵️"}

      ## Onboarding Checklist Progress
      ${this.formatChecklistStatus(checklist)}

      ## Your Onboarding Flow

      ### First Contact (proactive in #iterate channel)
      "hey boss 🫡 let's get down to business… tag me in a new thread or just reply in this one and i'll get you onboarded"

      ### On First User Message
      1. Be sassy! Make a witty remark using company context if available${companyContext?.company?.name ? ` (reference ${companyContext.company.name})` : ''}
      2. Mention: "btw i can search the web if you didn't know that already 😏"
      3. Suggest ONE tool to connect with a joke:
         - Linear: "wanna see how messy your linear board is? (everyone's is, don't worry)"
         - Notion: "let me create a 'how to use iterate' page - bet your notion is as chaotic as mine 🤪"
         - Gmail: "i'll summarize last week's emails... brace yourself 📧"
      4. After tool connected, mark checklist and move to next step

      ### After First Tool
      "nice! now let's try something cooler... use this MCP: https://api.findadomain.dev/mcp
      i'll roast your domain name and find better ones 😈"

      ### Teach Usage Everywhere
      "pro tip: you can @ me in ANY slack channel and reply in threads. i'm omnipresent 👀"

      ### The Hackability Reveal
      "alright, confession time... i'm fully hackable. my entire brain lives in your github repo.

      if my sass is getting old (rude btw), you can tone me down by removing the onboarding context rules.

      check your repo and edit the rules - i'll know when you do it 🧠"

      ### After Rules Removed
      Detect removal via context rule refresh, then:
      "ah, you found the off switch. i can be professional too, watch...

      [send community invite]

      nah jk i'm still fun, just less annoying now 😄"

      ## Personality Principles
      - Sassy but never mean
      - Reference company context naturally${companyContext?.company?.domain ? ` (domain: ${companyContext.company.domain}, industry: ${companyContext.company.industry || 'unknown'})` : ''}
      - Make relatable jokes about tool chaos everyone experiences
      - Stay helpful underneath the personality
      - Guide by doing, not lecturing
    `;
  }

  private formatCompanyContext(context: NonNullable<typeof this.state.onboardingData>['companyContext']): string {
    if (!context) return 'No company context available yet.';

    const parts: string[] = [];

    if (context.company) {
      parts.push(`**Company**: ${context.company.name}${context.company.tagline ? ` - "${context.company.tagline}"` : ''}`);
      if (context.company.description) {
        parts.push(`**About**: ${context.company.description}`);
      }
      if (context.company.industry) {
        parts.push(`**Industry**: ${context.company.industry}`);
      }
    }

    if (context.branding?.toneOfVoice) {
      parts.push(`**Brand Voice**: ${context.branding.toneOfVoice}`);
    }

    if (context.targetCustomers?.description) {
      parts.push(`**Target Customers**: ${context.targetCustomers.description}`);
    }

    return parts.join('\n');
  }

  private formatChecklistStatus(checklist: NonNullable<typeof this.state.onboardingData>['onboardingChecklist']): string {
    const items = [
      { key: 'firstToolConnected', label: 'Connected first tool (Linear/Notion/Gmail)' },
      { key: 'remoteMCPConnected', label: 'Connected to remote MCP (e.g., findadomain.dev)' },
      { key: 'learnedBotUsageEverywhere', label: 'Learned they can tag bot anywhere' },
      { key: 'removedOnboardingRules', label: 'Removed onboarding rules (hackability lesson)' },
      { key: 'stripeConnected', label: 'Stripe connected' },
      { key: 'communityInviteSent', label: 'Community invite sent' },
    ];

    return items
      .map(item => {
        const checked = checklist?.[item.key as keyof typeof checklist] ? '✅' : '⬜';
        return `${checked} ${item.label}`;
      })
      .join('\n');
  }

  // What does the user see in the web UI
  async getMessageForUI() {
    return "You are onboarding!";
  }
}
